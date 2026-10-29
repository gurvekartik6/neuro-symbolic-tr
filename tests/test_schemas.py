import unittest
from pydantic import ValidationError
from nscr.schemas import PlanResponse, PlanStep, TraceEvent
from nscr.verification import validate_step_graph

class SchemaTests(unittest.TestCase):
    def test_step_schema(self):
        s=PlanStep(id="S1",action="Inspect input",rationale="Need context",expected_result="Input checked")
        self.assertEqual(s.depends_on, [])
        self.assertTrue(s.reversible)

    def test_plan_requires_fields(self):
        p=PlanResponse(task_summary="Example",assumptions=[],steps=[PlanStep(id=f"S{i}",action=f"Step {i}",rationale="Because",expected_result="Result") for i in range(1,4)],constraints=[],uncertainty_notes=[])
        self.assertEqual(len(p.steps), 3)

    def test_cycle_plan_rejected(self):
        data={"steps":[{"id":"S1","depends_on":["S2"]},{"id":"S2","depends_on":["S1"]}]}
        with self.assertRaises(ValueError): validate_step_graph(data["steps"])

    def test_trace_requires_source(self):
        with self.assertRaises(ValidationError): TraceEvent(event_id="E1", status="failed")

if __name__ == "__main__": unittest.main()
