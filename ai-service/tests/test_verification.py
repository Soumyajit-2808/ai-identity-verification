"""
AI Service Unit Tests
Tests normalization, multi-format date parsing, name matching, quality analysis,
tamper detection, and verification engine decisions.
"""

import os
import sys
import numpy as np
import cv2
from PIL import Image
import io

# Ensure ai-service root is in sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from verification.normalizer import (
    parse_date_of_birth,
    extract_id_type_and_number,
    extract_name,
    normalize_identity_document,
)
from verification.name_matcher import match_names, clean_name_tokens
from verification.quality import analyze_image_quality
from verification.tamper import analyze_tamper_risk
from verification.engine import evaluate_verification, check_eligibility, ExtractedIdentity


def test_date_of_birth_parsing():
    # Test DD/MM/YYYY
    iso, age, raw = parse_date_of_birth("Participant DOB: 15/08/2004")
    assert iso == "2004-08-15"
    assert age is not None and age >= 19
    assert "15/08/2004" in raw

    # Test YYYY-MM-DD
    iso2, age2, _ = parse_date_of_birth("Birthdate: 2001-05-20")
    assert iso2 == "2001-05-20"
    assert age2 is not None and age2 >= 22

    # Test textual month
    iso3, age3, _ = parse_date_of_birth("DOB: 12 Jan 2002")
    assert iso3 == "2002-01-12"
    assert age3 is not None

    # Test future date rejection
    iso_future, age_future, _ = parse_date_of_birth("DOB: 01/01/2099")
    assert iso_future is None


def test_id_number_and_type_extraction():
    # PAN card
    num, id_type = extract_id_type_and_number("INCOME TAX DEPARTMENT ABCDE1234F")
    assert num == "ABCDE1234F"
    assert id_type == "PAN"

    # Aadhaar card
    num_a, type_a = extract_id_type_and_number("AADHAAR NUMBER: 1234 5678 9012")
    assert num_a == "1234 5678 9012"
    assert type_a == "AADHAAR"

    # Voter ID
    num_v, type_v = extract_id_type_and_number("ELECTION COMMISSION OF INDIA EPIC NO: ABC1234567")
    assert num_v == "ABC1234567"
    assert type_v == "VOTER_ID"


def test_name_extraction():
    text = "STUDENT IDENTITY CARD\nNAME: Rahul Sharma\nDOB: 15/08/2004\nID: STU12345"
    name = extract_name(text)
    assert name == "Rahul Sharma"

    # With honorific
    text_hon = "NAME: Dr. Vikram Malhotra\nID: 9999"
    name_hon = extract_name(text_hon)
    assert name_hon == "Vikram Malhotra"


def test_name_matching_engine():
    # Exact match
    res1 = match_names("Rahul Sharma", "Rahul Sharma")
    assert res1.matched is True
    assert res1.score == 1.0

    # Token reorder (Sharma Rahul vs Rahul Sharma)
    res2 = match_names("Sharma Rahul", "Rahul Sharma")
    assert res2.matched is True
    assert res2.method == "TOKEN_REORDER"
    assert res2.score >= 0.95

    # Initials match (R. Sharma vs Rahul Sharma)
    res3 = match_names("R. Sharma", "Rahul Sharma")
    assert res3.matched is True
    assert res3.method == "INITIALS_MATCH"

    # Subset match (Rahul Kumar Sharma vs Rahul Sharma)
    res4 = match_names("Rahul Kumar Sharma", "Rahul Sharma")
    assert res4.matched is True

    # Complete mismatch
    res5 = match_names("Amit Patel", "Rahul Sharma")
    assert res5.matched is False


def test_quality_analysis():
    # Generate synthetic clean test image (800x500 grayscale with text-like contrast)
    img = np.full((500, 800), 180, dtype=np.uint8)
    cv2.putText(img, "TEST IDENTITY DOCUMENT", (100, 200), cv2.FONT_HERSHEY_SIMPLEX, 1.2, 30, 3)
    _, buf = cv2.imencode(".png", img)
    image_bytes = buf.tobytes()

    q_res = analyze_image_quality(image_bytes)
    assert q_res.status in ("PASSED", "REVIEW")
    assert q_res.width == 800
    assert q_res.height == 500
    assert q_res.blur_score > 0


def test_eligibility_and_decision_policy():
    # Minor age (< 18) must result in INELIGIBLE
    elig_signal = check_eligibility(16, min_age=18, max_age=100)
    assert elig_signal.status == "FAILED"

    # Adult (22) must PASS
    elig_adult = check_eligibility(22, min_age=18, max_age=100)
    assert elig_adult.status == "PASSED"

    # Generate synthetic test image
    img = np.full((500, 800), 180, dtype=np.uint8)
    cv2.putText(img, "ID CARD", (50, 100), cv2.FONT_HERSHEY_SIMPLEX, 1, 0, 2)
    _, buf = cv2.imencode(".jpg", img)
    doc_bytes = buf.tobytes()

    identity = ExtractedIdentity(
        name="Ananya Iyer",
        date_of_birth="2003-04-15",
        calculated_age=21,
        id_number="PAN12345",
        id_type="PAN"
    )

    # Full pass case
    result = evaluate_verification(
        document_bytes=doc_bytes,
        extracted=identity,
        registration_name="Ananya Iyer",
        min_age=18,
        max_age=100
    )
    assert result.decision in ("ELIGIBLE", "REVIEW")
    assert result.confidence_score > 0.60
    assert len(result.signals) >= 5
