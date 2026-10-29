import unittest
from nscr.verification import dependency_cycles, evaluate_rule, verify_run, intervention_assessment

class VerificationTests(unittest.TestCase):
    def test_dependency_cycle_detected(self):
        steps = [{"id":"S1","depends_on":["S2"]},{"id":"S2","depends_on":["S1"]}]
        self.assertEqual(dependency_cycles(steps), [["S1", "S2", "S1"]])

    def test_rule_passes_against_recorded_event(self):
        result = evaluate_rule({"event_id":"E1","field":"status","operator":"equals","expected_value":"failed"}, {"E1":{"event_id":"E1","status":"failed"}})
        self.assertEqual(result["status"], "passed")

    def test_missing_rule_evidence_is_not_evaluable(self):
        result = evaluate_rule({"event_id":"MISSING","field":"status","operator":"equals","expected_value":"failed"}, {})
        self.assertEqual(result["status"], "not_evaluable")

    def test_report_does_not_claim_causality_from_failure_alone(self):
        plan = {"steps":[{"id":"S1","depends_on":[]}],"constraints":[]}
        trace = [{"event_id":"E1","step_id":"S1","status":"failed","source":"user supplied","input_observation":"input","output_observation":"error","preconditions_met":True,"postconditions_met":False}]
        report = verify_run(plan, trace)
        self.assertEqual(report["failed_events"], ["E1"])
        self.assertEqual(report["causal_conclusion"], "undetermined")

    def test_intervention_not_executed_is_undetermined(self):
        payload = {"candidate_step_id":"S1","intervention_was_executed":False,"conditions_held_constant":[],"baseline_outcome":"fail","intervention_outcome":"pass"}
        self.assertEqual(intervention_assessment(payload, {"S1"})["status"], "undetermined")

    def test_intervention_requires_controls(self):
        payload = {"candidate_step_id":"S1","intervention_was_executed":True,"conditions_held_constant":[],"baseline_outcome":"fail","intervention_outcome":"pass"}
        self.assertEqual(intervention_assessment(payload, {"S1"})["status"], "undetermined")

if __name__ == "__main__": unittest.main()
