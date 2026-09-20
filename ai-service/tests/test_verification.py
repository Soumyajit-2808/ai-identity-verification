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
    CANONICAL_ID_TYPES,
)
from verification.name_matcher import match_names, clean_name_tokens
from verification.quality import analyze_image_quality
from verification.tamper import analyze_tamper_risk
from verification.engine import evaluate_verification, check_eligibility, ExtractedIdentity


def test_date_of_birth_parsing():
    # Test DD/MM/YYYY unambiguous (day > 12)
    iso, age, raw, is_ambig, alt_age, alt_date = parse_date_of_birth("Participant DOB: 15/08/2004")
    assert iso == "2004-08-15"
    assert age is not None and age >= 19
    assert "15/08/2004" in raw
    assert is_ambig is False

    # Test YYYY-MM-DD unambiguous
    iso2, age2, _, is_ambig2, _, _ = parse_date_of_birth("Birthdate: 2001-05-20")
    assert iso2 == "2001-05-20"
    assert age2 is not None and age2 >= 22
    assert is_ambig2 is False

    # Test textual month unambiguous
    iso3, age3, _, is_ambig3, _, _ = parse_date_of_birth("DOB: 12 Jan 2002")
    assert iso3 == "2002-01-12"
    assert age3 is not None
    assert is_ambig3 is False

    # Test future date rejection
    iso_future, age_future, _, _, _, _ = parse_date_of_birth("DOB: 01/01/2099")
    assert iso_future is None

    # Test ambiguous date (DD/MM vs MM/DD both <= 12 and different)
    iso_amb, age_amb, raw_amb, is_ambig_flag, alt_age_val, alt_date_val = parse_date_of_birth("DOB: 05/06/2004")
    assert iso_amb == "2004-06-05"  # default DD/MM/YYYY
    assert is_ambig_flag is True
    assert alt_date_val == "2004-05-06"  # alternative MM/DD/YYYY
    assert alt_age_val is not None


def test_ambiguous_dob_eligibility_routing():
    # If a date has age 18 in DD/MM but age 17 in MM/DD, or vice versa, check_eligibility must flag REVIEW
    signal = check_eligibility(
        age=18,
        min_age=18,
        max_age=100,
        dob_ambiguous=True,
        alt_age=17,
        raw_dob="05/06/2006",
    )
    assert signal.status == "REVIEW"
    assert "ambiguous" in signal.reason.lower()

    # If both interpretations are adult (e.g. age 22 and age 22), it should pass
    signal_clear = check_eligibility(
        age=22,
        min_age=18,
        max_age=100,
        dob_ambiguous=True,
        alt_age=22,
        raw_dob="05/06/2002",
    )
    assert signal_clear.status == "PASSED"


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

    # Driving License
    num_dl, type_dl = extract_id_type_and_number("DRIVING LICENCE DL-1420110012345")
    assert num_dl is not None
    assert type_dl == "DRIVING_LICENSE"

    # Passport
    num_p, type_p = extract_id_type_and_number("PASSPORT OF REPUBLIC OF INDIA J1234567")
    assert num_p == "J1234567"
    assert type_p == "PASSPORT"

    # Student ID
    num_s, type_s = extract_id_type_and_number("STUDENT IDENTITY CARD STUDENT ID: STU202488")
    assert num_s == "STU202488"
    assert type_s == "STUDENT_ID"

    # Adversarial OCR test: generic uppercase words without specific document patterns
    # must NOT extract false ID numbers like "CERTIFICATE" or "DEPARTMENT"
    num_junk, type_junk = extract_id_type_and_number("GOVERNMENT OF INDIA CERTIFICATE OF PARTICIPATION")
    assert num_junk is None, f"Expected None for junk OCR text, got {num_junk}"


def test_canonical_id_types_vocabulary():
    expected = {"PASSPORT", "DRIVING_LICENSE", "STUDENT_ID", "NATIONAL_ID", "AADHAAR", "PAN", "VOTER_ID"}
    assert CANONICAL_ID_TYPES == expected


def test_name_extraction():
    text = "STUDENT IDENTITY CARD\nNAME: Rahul Sharma\nDOB: 15/08/2004\nID: STU12345"
    name = extract_name(text)
    assert name == "Rahul Sharma"

    # With title/honorific (Dr.)
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

    # Subset match (Rahul Kumar Sharma vs Rahul Sharma) - Kumar is middle name here
    res4 = match_names("Rahul Kumar Sharma", "Rahul Sharma")
    assert res4.matched is True

    # Complete mismatch
    res5 = match_names("Amit Patel", "Rahul Sharma")
    assert res5.matched is False

    # Adversarial: "Amit Kumar" vs "Amit Sharma" - Kumar is surname, must NOT match!
    res_kumar = match_names("Amit Kumar", "Amit Sharma")
    assert res_kumar.matched is False, "Amit Kumar vs Amit Sharma must not match (Kumar is a surname)"

    # Adversarial: "Rahul Sharma" vs "Rahul Sharma Kumar" - different surnames, must NOT match!
    res_rsk = match_names("Rahul Sharma", "Rahul Sharma Kumar")
    assert res_rsk.matched is False, "Rahul Sharma vs Rahul Sharma Kumar must not match"

    # Adversarial: "Rahul Sharma" vs "Rohan Sharma" - different first names, must NOT match!
    res_rohan = match_names("Rahul Sharma", "Rohan Sharma")
    assert res_rohan.matched is False, "Rahul Sharma vs Rohan Sharma must not match"

    # Adversarial: "Kumar Sharma" vs "Rahul Kumar Sharma" - different first names, must NOT match!
    res_ks = match_names("Kumar Sharma", "Rahul Kumar Sharma")
    assert res_ks.matched is False, "Kumar Sharma vs Rahul Kumar Sharma must not match"

    # Adversarial: strict mode on subset match
    res_strict = match_names("Rahul Kumar Sharma", "Rahul Sharma", strict=True)
    assert res_strict.matched is False, "Strict mode must reject subset match"

    # Adversarial: "Amit Kumar" vs "Amit Kumari" - distinct gendered names, must NOT match!
    res_kumar_kumari = match_names("Amit Kumar", "Amit Kumari")
    assert res_kumar_kumari.matched is False, "Amit Kumar vs Amit Kumari must not match (distinct names)"

    # Adversarial: "A Sharma" vs "Amit Sharma" - initial expansion match
    res_a_sharma = match_names("A Sharma", "Amit Sharma")
    assert res_a_sharma.matched is True, "A Sharma vs Amit Sharma should match via initial expansion"

    # Adversarial: "Sharma Rahul" vs "Rahul Sharma" - reordered match
    res_reorder = match_names("Sharma Rahul", "Rahul Sharma")
    assert res_reorder.matched is True, "Sharma Rahul vs Rahul Sharma should match via token reorder"

    # Adversarial: "Rahul Dev Sharma" vs "Rahul Sharma" - middle name expansion match
    res_dev = match_names("Rahul Dev Sharma", "Rahul Sharma")
    assert res_dev.matched is True, "Rahul Dev Sharma vs Rahul Sharma should match via middle name expansion"

    # Adversarial: "R K Sharma" vs "Rahul Kumar Sharma" - multi-initial match
    res_rk = match_names("R K Sharma", "Rahul Kumar Sharma")
    assert res_rk.matched is True, "R K Sharma vs Rahul Kumar Sharma should match"

    # Adversarial: completely unrelated names
    assert match_names("John Doe", "Jane Smith").matched is False
    assert match_names("Vikram Patel", "Suresh Kumar").matched is False

    # OCR typo that SHOULD match: "Rahui Sharma" vs "Rahul Sharma" (1-char typo)
    res_typo = match_names("Rahui Sharma", "Rahul Sharma")
    assert res_typo.matched is True, "Minor OCR typo Rahui vs Rahul should match"


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


def test_tamper_analysis():
    # Synthetic clean image
    img = np.full((500, 800, 3), 200, dtype=np.uint8)
    cv2.putText(img, "CLEAN ID", (50, 100), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 0), 2)
    _, buf = cv2.imencode(".jpg", img)
    image_bytes = buf.tobytes()

    res = analyze_tamper_risk(image_bytes)
    assert res.status in ("PASSED", "REVIEW")
    assert res.risk_level in ("LOW", "MEDIUM", "HIGH")


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
        id_number="ABCDE1234F",
        id_type="PAN"
    )

    # Full pass case
    result = evaluate_verification(
        document_bytes=doc_bytes,
        extracted=identity,
        registration_name="Ananya Iyer",
        min_age=18,
        max_age=100,
        allowed_id_types=["PAN", "AADHAAR", "PASSPORT"]
    )
    assert result.decision in ("ELIGIBLE", "REVIEW")
    assert result.confidence_score > 0.60
    assert len(result.signals) >= 5
