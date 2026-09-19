"""
Verification Decision & Evidence Scoring Engine
Aggregates atomic signals into explainable verification decisions with calibrated evidence and risk scores.
"""

from typing import Optional, List, Dict, Any
from pydantic import BaseModel

from verification.normalizer import ExtractedIdentity
from verification.name_matcher import NameMatchResult, match_names
from verification.quality import QualityResult, analyze_image_quality
from verification.tamper import TamperResult, analyze_tamper_risk
from verification.face import FaceVerificationResult, verify_faces


class AtomicSignal(BaseModel):
    signal_type: str
    status: str       # "PASSED", "REVIEW", "FAILED", "SKIPPED"
    score: Optional[float] = None
    reason: str
    details: Dict[str, Any] = {}


class VerificationEngineResult(BaseModel):
    decision: str             # "ELIGIBLE", "INELIGIBLE", "REVIEW"
    confidence_score: float   # Calibrated confidence (0.00 - 1.00)
    evidence_score: float     # Positive corroboration weight (0.00 - 1.00)
    risk_score: float         # Risk and anomaly indicator weight (0.00 - 1.00)
    summary_reason: str
    extracted_identity: ExtractedIdentity
    signals: List[AtomicSignal]


def check_eligibility(
    age: Optional[int],
    min_age: int = 18,
    max_age: int = 100
) -> AtomicSignal:
    if age is None:
        return AtomicSignal(
            signal_type="ELIGIBILITY",
            status="REVIEW",
            score=0.0,
            reason="Date of birth could not be reliably extracted to calculate age eligibility.",
            details={"min_age": min_age, "max_age": max_age, "calculated_age": None}
        )

    if age < min_age:
        return AtomicSignal(
            signal_type="ELIGIBILITY",
            status="FAILED",
            score=0.0,
            reason=f"Applicant age ({age}) is below the minimum permitted age of {min_age}.",
            details={"min_age": min_age, "max_age": max_age, "calculated_age": age}
        )

    if age > max_age:
        return AtomicSignal(
            signal_type="ELIGIBILITY",
            status="FAILED",
            score=0.0,
            reason=f"Applicant age ({age}) exceeds the maximum permitted age of {max_age}.",
            details={"min_age": min_age, "max_age": max_age, "calculated_age": age}
        )

    return AtomicSignal(
        signal_type="ELIGIBILITY",
        status="PASSED",
        score=1.0,
        reason=f"Applicant age ({age}) satisfies the configured eligibility requirement ({min_age} to {max_age} years).",
        details={"min_age": min_age, "max_age": max_age, "calculated_age": age}
    )


def evaluate_verification(
    document_bytes: bytes,
    extracted: ExtractedIdentity,
    registration_name: str,
    min_age: int = 18,
    max_age: int = 100,
    selfie_bytes: Optional[bytes] = None,
    require_selfie: bool = False,
    strict_name_matching: bool = False,
    allowed_id_types: Optional[List[str]] = None,
) -> VerificationEngineResult:
    signals: List[AtomicSignal] = []

    # 1. OCR Extraction Completeness Signal
    ocr_details = {
        "has_name": bool(extracted.name),
        "has_dob": bool(extracted.date_of_birth),
        "has_id_number": bool(extracted.id_number),
        "id_type": extracted.id_type,
    }
    if extracted.name and extracted.date_of_birth:
        ocr_status = "PASSED"
        ocr_score = 1.0 if extracted.id_number else 0.85
        ocr_reason = f"Essential identity fields (name, date of birth) were extracted successfully. Document type identified as {extracted.id_type}."
    else:
        ocr_status = "REVIEW"
        ocr_score = 0.40
        missing = []
        if not extracted.name: missing.append("name")
        if not extracted.date_of_birth: missing.append("date of birth")
        ocr_reason = f"OCR extraction was incomplete; could not reliably extract: {', '.join(missing)}."

    signals.append(AtomicSignal(
        signal_type="OCR",
        status=ocr_status,
        score=ocr_score,
        reason=ocr_reason,
        details=ocr_details
    ))

    # 2. Image Quality Signal
    quality_res = analyze_image_quality(document_bytes)
    signals.append(AtomicSignal(
        signal_type="QUALITY",
        status=quality_res.status,
        score=round(min(1.0, quality_res.blur_score / 150.0), 2),
        reason=quality_res.reason,
        details={
            "blur_score": quality_res.blur_score,
            "brightness": quality_res.brightness_score,
            "contrast": quality_res.contrast_score,
            "glare_ratio": quality_res.glare_ratio,
            "resolution": f"{quality_res.width}x{quality_res.height}",
            "issues": quality_res.issues,
        }
    ))

    # 3. Tamper-Risk Signal
    tamper_res = analyze_tamper_risk(document_bytes)
    tamper_score = 1.0 if tamper_res.risk_level == "LOW" else (0.50 if tamper_res.risk_level == "MEDIUM" else 0.20)
    signals.append(AtomicSignal(
        signal_type="TAMPER",
        status=tamper_res.status,
        score=tamper_score,
        reason=tamper_res.reason,
        details={
            "risk_level": tamper_res.risk_level,
            "signals": tamper_res.signals,
            "ela_score": tamper_res.ela_score,
            "editing_tools": tamper_res.editing_tools_detected,
        }
    ))

    # 4. Eligibility Check Signal
    eligibility_signal = check_eligibility(extracted.calculated_age, min_age, max_age)
    signals.append(eligibility_signal)

    # 5. Registration Name Match Signal
    name_res = match_names(extracted.name, registration_name, strict=strict_name_matching)
    signals.append(AtomicSignal(
        signal_type="NAME_MATCH",
        status="PASSED" if name_res.matched else "REVIEW",
        score=name_res.score,
        reason=f"Registration name '{registration_name}' matched extracted name '{extracted.name}' (score: {name_res.score}, method: {name_res.method})."
               if name_res.matched else
               f"Registration name '{registration_name}' does not sufficiently match extracted name '{extracted.name}' (similarity {name_res.score} < threshold {name_res.threshold}).",
        details=name_res.details
    ))

    # 6. Biometric Face Match Signal
    face_res = verify_faces(document_bytes, selfie_bytes)
    if face_res.status == "NOT_PROVIDED":
        face_signal_status = "REVIEW" if require_selfie else "SKIPPED"
        face_reason = "Mandatory selfie was not provided." if require_selfie else "Selfie was not provided; face verification was skipped."
    else:
        face_signal_status = face_res.status
        face_reason = face_res.reason

    signals.append(AtomicSignal(
        signal_type="FACE_MATCH",
        status=face_signal_status,
        score=face_res.similarity_score,
        reason=face_reason,
        details={
            "match": face_res.match,
            "state": face_res.state,
            "distance": face_res.distance,
            "threshold": face_res.threshold,
            "liveness_verified": face_res.liveness_verified,
        }
    ))

    # 7. Document Type Permitted Signal
    doc_type_status = "PASSED"
    if allowed_id_types:
        id_type = (extracted.id_type or "UNKNOWN").upper()
        if id_type in allowed_id_types:
            doc_type_status = "PASSED"
            doc_type_score = 1.0
            doc_type_reason = f"Extracted document type '{id_type}' is permitted for this event."
        elif id_type == "UNKNOWN":
            doc_type_status = "REVIEW"
            doc_type_score = 0.40
            doc_type_reason = "Document type could not be definitively recognized; manual review required."
        else:
            doc_type_status = "REVIEW"
            doc_type_score = 0.0
            doc_type_reason = f"Document type '{id_type}' is not among permitted ID types for this event: {', '.join(allowed_id_types)}."

        signals.append(AtomicSignal(
            signal_type="DOCUMENT_TYPE",
            status=doc_type_status,
            score=doc_type_score,
            reason=doc_type_reason,
            details={"extracted_id_type": id_type, "allowed_id_types": allowed_id_types}
        ))

    # -------------------------------------------------------------
    # Multi-Signal Evidence & Risk Scoring
    # -------------------------------------------------------------
    # Evidence score represents positive corroboration across verified signals (0.0 to 1.0)
    pos_evidence = 0.0
    if ocr_status == "PASSED": pos_evidence += 0.25
    if quality_res.status == "PASSED": pos_evidence += 0.15
    if tamper_res.risk_level == "LOW": pos_evidence += 0.15
    if eligibility_signal.status == "PASSED": pos_evidence += 0.25
    if name_res.matched: pos_evidence += 0.20
    if face_res.status == "PASSED": pos_evidence += 0.15
    if doc_type_status == "PASSED" and allowed_id_types: pos_evidence += 0.10

    evidence_score = round(min(1.0, pos_evidence), 2)

    # Risk score represents presence of anomalies, mismatches, and defects (0.0 to 1.0)
    risk = 0.0
    if quality_res.status == "FAILED": risk += 0.40
    elif quality_res.status == "REVIEW": risk += 0.20

    if tamper_res.risk_level == "HIGH": risk += 0.50
    elif tamper_res.risk_level == "MEDIUM": risk += 0.25

    if not name_res.matched: risk += 0.35
    if face_res.status == "FAILED": risk += 0.45
    elif face_res.status == "REVIEW": risk += 0.30

    if doc_type_status == "REVIEW": risk += 0.35

    risk_score = round(min(1.0, risk), 2)

    # Calibrated confidence score based on corroborated evidence penalized by detected risk
    confidence_score = round(max(0.10, min(0.98, evidence_score * (1.0 - (risk_score * 0.7)))), 2)

    # -------------------------------------------------------------
    # Decision Policy Synthesis
    # -------------------------------------------------------------
    # Rule 1: Eligibility failure is absolute INELIGIBLE
    if eligibility_signal.status == "FAILED":
        decision = "INELIGIBLE"
        summary_reason = eligibility_signal.reason

    # Rule 2: Critical issues route to REVIEW
    elif (
        ocr_status == "REVIEW" or
        quality_res.status in ("FAILED", "REVIEW") or
        tamper_res.risk_level in ("MEDIUM", "HIGH") or
        not name_res.matched or
        face_res.status in ("FAILED", "REVIEW") or
        doc_type_status == "REVIEW" or
        (require_selfie and face_res.status == "NOT_PROVIDED") or
        risk_score >= 0.30
    ):
        decision = "REVIEW"
        reasons = []
        if ocr_status == "REVIEW":
            reasons.append("incomplete OCR field extraction")
        if quality_res.status != "PASSED":
            reasons.append("suboptimal document quality")
        if tamper_res.risk_level != "LOW":
            reasons.append("tampering or structural anomaly flags")
        if not name_res.matched:
            reasons.append("registration name discrepancy")
        if face_res.status in ("FAILED", "REVIEW"):
            reasons.append("facial verification mismatch or detection anomaly")
        if doc_type_status == "REVIEW":
            reasons.append("unsupported or unrecognized document type")
        if require_selfie and face_res.status == "NOT_PROVIDED":
            reasons.append("missing mandatory selfie")

        summary_reason = f"Manual operator review is required due to: {', '.join(reasons)}."

    # Rule 3: All verified clean
    else:
        decision = "ELIGIBLE"
        summary_reason = (
            "Automated verification passed successfully. Identity document fields were extracted, "
            "document quality is acceptable, no tampering anomalies were observed, age eligibility was verified, "
            "and registration name matches the identity document."
        )

    return VerificationEngineResult(
        decision=decision,
        confidence_score=confidence_score,
        evidence_score=evidence_score,
        risk_score=risk_score,
        summary_reason=summary_reason,
        extracted_identity=extracted,
        signals=signals,
    )