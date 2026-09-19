"""
AI Service Test Runner
Runs all unit and integration tests without requiring third-party test runners.
"""

import os
import sys
import unittest

# Ensure ai-service root is on path
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
AI_SERVICE_DIR = os.path.abspath(os.path.join(CURRENT_DIR, ".."))
sys.path.insert(0, AI_SERVICE_DIR)

from tests.test_verification import (
    test_date_of_birth_parsing,
    test_id_number_and_type_extraction,
    test_name_extraction,
    test_name_matching_engine,
    test_quality_analysis,
    test_eligibility_and_decision_policy,
)


class AIServiceTestCase(unittest.TestCase):
    def test_dob_parsing(self):
        test_date_of_birth_parsing()

    def test_id_extraction(self):
        test_id_number_and_type_extraction()

    def test_name_extract(self):
        test_name_extraction()

    def test_name_matching(self):
        test_name_matching_engine()

    def test_quality(self):
        test_quality_analysis()

    def test_eligibility(self):
        test_eligibility_and_decision_policy()


if __name__ == "__main__":
    suite = unittest.TestLoader().loadTestsFromTestCase(AIServiceTestCase)
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
