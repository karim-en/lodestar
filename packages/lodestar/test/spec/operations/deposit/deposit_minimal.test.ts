import {join} from "path";
import {expect} from "chai";
import {equals} from "@chainsafe/ssz";
import {config} from "@chainsafe/eth2.0-config/lib/presets/minimal";
import {processDeposit} from "../../../../src/chain/stateTransition/block/operations";
import {BeaconState} from "@chainsafe/eth2.0-types";
import {describeDirectorySpecTest} from "@chainsafe/eth2.0-spec-test-util/lib/single";
import {ProcessDepositTestCase} from "./type";
import {SPEC_TEST_LOCATION} from "../../../utils/specTestCases";

describeDirectorySpecTest<ProcessDepositTestCase, BeaconState>(
  "process deposit minimal",
  join(SPEC_TEST_LOCATION, "/tests/minimal/phase0/operations/deposit/pyspec_tests"),
  (testcase) => {
    const state = testcase.pre;
    processDeposit(config, state, testcase.deposit);
    return state;
  },
  {
    sszTypes: {
      pre: config.types.BeaconState,
      post: config.types.BeaconState,
      deposit: config.types.Deposit,
    },
    timeout: 100000000,
    shouldError: testCase => !testCase.post,
    getExpected: (testCase => testCase.post),
    expectFunc: (testCase, expected, actual) => {
      expect(equals(actual, expected, config.types.BeaconState)).to.be.true;
    }
  }
);

