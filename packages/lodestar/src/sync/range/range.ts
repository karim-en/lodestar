import {computeEpochAtSlot, computeStartSlotAtEpoch} from "@chainsafe/lodestar-beacon-state-transition";
import {IBeaconConfig} from "@chainsafe/lodestar-config";
import {Epoch, Slot, Status} from "@chainsafe/lodestar-types";
import {ErrorAborted, ILogger} from "@chainsafe/lodestar-utils";
import PeerId from "peer-id";
import {IBeaconChain} from "../../chain";
import {RangeSyncType, getRangeSyncType} from "../utils/remoteSyncType";
import {ChainTarget, DownloadBeaconBlocksByRange, ProcessChainSegment, SyncChain, SyncChainOpts} from "./chain";
import {AbortSignal} from "abort-controller";
import {Json, toHexString} from "@chainsafe/ssz";
import {updateChains} from "./utils/updateChains";
import {shouldRemoveChain} from "./utils/shouldRemoveChain";
import {INetwork, PeerAction} from "../../network";
import {assertSequentialBlocksInRange} from "../utils";

//! This contains the logic for the long range (batch) sync strategy.
//!
//! The general premise is to group peers by their self-proclaimed finalized blocks and head
//! blocks. Once grouped, the peers become sources to download a specific `Chain`. A `Chain` is a
//! collection of blocks that terminates at the specified target head.
//!
//! This sync strategy can be separated into two distinct forms:
//!  - Finalized Chain Sync
//!  - Head Chain Sync
//!
//!  ## Finalized chain sync
//!
//!  This occurs when a peer connects that claims to have a finalized head slot that is greater
//!  than our own. In this case, we form a chain from our last finalized epoch, to their claimed
//!  finalized slot. Any peer that also claims to have this last finalized slot is added to a pool
//!  of peers from which batches of blocks may be downloaded. Blocks are downloaded until the
//!  finalized slot of the chain is reached. Once reached, all peers within the pool are sent a
//!  STATUS message to potentially start a head chain sync, or check if further finalized chains
//!  need to be downloaded.
//!
//!  A few interesting notes about finalized chain syncing:
//!  - Only one finalized chain can sync at a time
//!  - The finalized chain with the largest peer pool takes priority.
//!  - As one finalized chain completes, others are checked to see if we they can be continued,
//!  otherwise they are removed.
//!
//!  ## Head Chain Sync
//!
//!  If a peer joins and there is no active finalized chains being synced, and it's head is beyond
//!  our `SLOT_IMPORT_TOLERANCE` a chain is formed starting from this peers finalized epoch (this
//!  has been necessarily downloaded by our node, otherwise we would start a finalized chain sync)
//!  to this peers head slot. Any other peers that match this head slot and head root, are added to
//!  this chain's peer pool, which will be downloaded in parallel.
//!
//!  Unlike finalized chains, head chains can be synced in parallel.
//!
//!  ## Batch Syncing
//!
//!  Each chain is downloaded in batches of blocks. The batched blocks are processed sequentially
//!  and further batches are requested as current blocks are being processed.

export enum RangeSyncStatus {
  /// A finalized chain is being synced.
  // (u64)
  Finalized,
  /// There are no finalized chains and we are syncing one more head chains.
  // (SmallVec<[u64; PARALLEL_HEAD_CHAINS]>)
  Head,
  /// There are no head or finalized chains and no long range sync is in progress.
  Idle,
}

type SyncChainId = string;

type RangeSyncState =
  | {status: RangeSyncStatus.Finalized; target: ChainTarget}
  | {status: RangeSyncStatus.Head; targets: ChainTarget[]}
  | {status: RangeSyncStatus.Idle};

export type RangeSyncModules = {
  chain: IBeaconChain;
  network: INetwork;
  config: IBeaconConfig;
  logger: ILogger;
};

export type RangeSyncOpts = SyncChainOpts;

export class RangeSync {
  chain: IBeaconChain;
  network: INetwork;
  config: IBeaconConfig;
  logger: ILogger;
  chains = new Map<SyncChainId, SyncChain>();
  state: RangeSyncState = {status: RangeSyncStatus.Idle};

  private signal: AbortSignal;
  private opts?: SyncChainOpts;

  constructor({chain, network, config, logger}: RangeSyncModules, signal: AbortSignal, opts?: SyncChainOpts) {
    this.chain = chain;
    this.network = network;
    this.config = config;
    this.logger = logger;
    this.signal = signal;
    this.opts = opts;

    // Throw / return all AsyncGenerators inside each SyncChain instance
    signal.addEventListener("abort", () => {
      for (const chain of this.chains.values()) {
        chain.remove();
      }
    });
  }

  /// A useful peer has been added. The SyncManager has identified this peer as needing either
  /// a finalized or head chain sync. This processes the peer and starts/resumes any chain that
  /// may need to be synced as a result. A new peer, may increase the peer pool of a finalized
  /// chain, this may result in a different finalized chain from syncing as finalized chains are
  /// prioritised by peer-pool size.
  addPeer(peerId: PeerId, localStatus: Status, peerStatus: Status): void {
    // evaluate which chain to sync from

    // determine if we need to run a sync to the nearest finalized state or simply sync to
    // its current head

    const rangeSyncType = getRangeSyncType(this.chain, localStatus, peerStatus);
    this.logger.debug("Sync peer joined", {peer: peerId.toB58String(), rangeSyncType});

    // if the peer existed in any other chain, remove it.
    this.removePeer(peerId);

    let startEpoch: Slot;
    let target: ChainTarget;

    switch (rangeSyncType) {
      case RangeSyncType.Finalized: {
        startEpoch = localStatus.finalizedEpoch;
        target = {
          slot: computeStartSlotAtEpoch(this.config, peerStatus.finalizedEpoch),
          root: peerStatus.finalizedRoot,
        };
        break;
      }

      case RangeSyncType.Head: {
        // The new peer has the same finalized (earlier filters should prevent a peer with an
        // earlier finalized chain from reaching here).
        startEpoch = Math.min(computeEpochAtSlot(this.config, localStatus.headSlot), peerStatus.finalizedEpoch);
        target = {
          slot: peerStatus.headSlot,
          root: peerStatus.headRoot,
        };
        break;
      }
    }

    this.addPeerOrCreateChain(startEpoch, target, peerId, RangeSyncType.Finalized);
    this.update(localStatus.finalizedEpoch);
  }

  /// When a peer gets removed, both the head and finalized chains need to be searched to check
  /// which pool the peer is in. The chain may also have a batch or batches awaiting
  /// for this peer. If so we mark the batch as failed. The batch may then hit it's maximum
  /// retries. In this case, we need to remove the chain.
  removePeer(peerId: PeerId): void {
    for (const syncChain of this.chains.values()) {
      syncChain.removePeer(peerId);
    }
  }

  syncState(): RangeSyncState {
    const syncingHeadTargets: ChainTarget[] = [];
    for (const chain of this.chains.values()) {
      if (chain.isSyncing) {
        if (chain.syncType === RangeSyncType.Finalized) {
          return {status: RangeSyncStatus.Finalized, target: chain.target};
        } else {
          syncingHeadTargets.push(chain.target);
        }
      }
    }

    if (syncingHeadTargets.length > 0) {
      return {status: RangeSyncStatus.Head, targets: syncingHeadTargets};
    } else {
      return {status: RangeSyncStatus.Idle};
    }
  }

  /**
   * Convenience method for `SyncChain`
   */
  private processChainSegment: ProcessChainSegment = async (blocks) => {
    const trusted = true; // TODO: Verify signatures
    await this.chain.processChainSegment(blocks, trusted);
  };

  /**
   * Convenience method for `SyncChain`
   */
  private downloadBeaconBlocksByRange: DownloadBeaconBlocksByRange = async (peerId, request) => {
    const blocks = await this.network.reqResp.beaconBlocksByRange(peerId, request);
    assertSequentialBlocksInRange(blocks, request);
    return blocks;
  };

  private reportPeer = (peer: PeerId, action: PeerAction, actionName: string): void => {
    this.network.peerRpcScores.applyAction(peer, action, actionName);
  };

  private addPeerOrCreateChain(startEpoch: Epoch, target: ChainTarget, peer: PeerId, syncType: RangeSyncType): void {
    const id = getSyncChainId(syncType, target);

    let syncingChain = this.chains.get(id);
    if (!syncingChain) {
      this.logger.debug("New syncingChain", {slot: target.slot, root: toHexString(target.root), startEpoch});
      syncingChain = new SyncChain(
        startEpoch,
        target,
        syncType,
        this.processChainSegment,
        this.downloadBeaconBlocksByRange,
        this.reportPeer,
        this.config,
        this.logger,
        this.opts
      );
      this.chains.set(id, syncingChain);
    }

    syncingChain.addPeer(peer);
  }

  private update(localFinalizedEpoch: Epoch): void {
    /// Removes any outdated finalized or head chains.
    /// This removes chains with no peers, or chains whose start block slot is less than our current
    /// finalized block slot. Peers that would create outdated chains are removed too.
    const localFinalizedSlot = computeStartSlotAtEpoch(this.config, localFinalizedEpoch);

    // Remove chains that are out-dated, peer-empty, completed or failed
    for (const [id, syncChain] of this.chains.entries()) {
      if (shouldRemoveChain(syncChain, localFinalizedSlot, this.chain)) {
        syncChain.remove();
        this.chains.delete(id);
        this.logger.debug("Removed chain", {id});

        // Re-status peers
        // TODO: Then what? On new status call the add handler and repeat?
        // this.network.statusPeers(syncChain.peers);
      }
    }

    const {toStop, toStart} = updateChains(Array.from(this.chains.values()));

    for (const syncChain of toStop) {
      syncChain.stopSyncing();
    }

    for (const syncChain of toStart) {
      void this.runChain(syncChain, localFinalizedEpoch);
    }
  }

  private async runChain(syncChain: SyncChain, localFinalizedEpoch: Epoch): Promise<void> {
    const syncChainMetdata = (syncChain.getMetadata() as unknown) as Json;

    try {
      await syncChain.startSyncing(localFinalizedEpoch);
      this.logger.verbose("SyncChain reached target", syncChainMetdata);
    } catch (e) {
      if (e instanceof ErrorAborted) {
        return; // Ignore
      } else {
        this.logger.error("SyncChain error", syncChainMetdata, e);
      }
    }

    const localStatus = await this.chain.getStatus();
    this.update(localStatus.finalizedEpoch);
  }
}

function getSyncChainId(syncType: RangeSyncType, target: ChainTarget): SyncChainId {
  return `${syncType}-${target.slot}-${toHexString(target.root)}`;
}
