import hashlib
import re
from datetime import date, datetime

import cv2
import numpy as np
from PIL import Image


# In-memory duplicate registry for the prototype.
# Later this will move to PostgreSQL.
SEEN_DOCUMENTS = set()
SEEN_IDENTITIES = {}


def normalize_name(name):
    if not name:
        return ""

    name = name.upper()
    name = re.sub(r"[^A-Z0-9 ]", " ", name)
    name = re.sub(r"\s+", " ", name)

    return name.strip()


def names_match(ocr_name, registration_name):
    if not ocr_name or not registration_name:
        return None

    a = normalize_name(ocr_name)
    b = normalize_name(registration_name)

    if not a or not b:
        return False

    if a == b:
        return True

    # Handles minor OCR differences.
    a_parts = set(a.split())
    b_parts = set(b.split())

    if not a_parts or not b_parts:
        return False

    overlap = len(a_parts.intersection(b_parts))
    similarity = overlap / max(len(a_parts), len(b_parts))

    return similarity >= 0.75


def calculate_age(dob_text):
    if not dob_text:
        return None

    formats = [
        "%d/%m/%Y",
        "%d-%m-%Y",
        "%Y/%m/%d",
        "%Y-%m-%d",
        "%d/%m/%y",
        "%d-%m-%y",
    ]

    dob = None

    for fmt in formats:
        try:
            dob = datetime.strptime(dob_text, fmt).date()
            break
        except ValueError:
            continue

    if not dob:
        return None

    today = date.today()

    age = today.year - dob.year

    if (today.month, today.day) < (dob.month, dob.day):
        age -= 1

    return age


def check_eligibility(dob_text, min_age, max_age):
    age = calculate_age(dob_text)

    if age is None:
        return {
            "status": "review",
            "age": None,
            "reason": "Date of birth could not be reliably extracted."
        }

    if age < min_age:
        return {
            "status": "failed",
            "age": age,
            "reason": f"Registrant is below the configured minimum age of {min_age}."
        }

    if age > max_age:
        return {
            "status": "failed",
            "age": age,
            "reason": f"Registrant is above the configured maximum age of {max_age}."
        }

    return {
        "status": "passed",
        "age": age,
        "reason": "Age falls within the configured eligibility range."
    }


def calculate_document_hash(contents):
    return hashlib.sha256(contents).hexdigest()


def check_duplicate(contents):
    document_hash = calculate_document_hash(contents)

    if document_hash in SEEN_DOCUMENTS:
        return {
            "status": "detected",
            "hash": document_hash,
            "reason": "The exact same document file has already been submitted."
        }

    SEEN_DOCUMENTS.add(document_hash)

    return {
        "status": "not_detected",
        "hash": document_hash,
        "reason": "No identical document submission was detected."
    }

def check_identity_duplicate(identity):
    """
    Detect reuse of the same extracted identity information,
    even when the uploaded image itself is different.
    """

    id_number = identity.get("id_number")

    if not id_number:
        return {
            "status": "review",
            "reason": "No reliable ID number was extracted, so identity reuse could not be checked."
        }

    normalized_id = re.sub(r"[^A-Z0-9]", "", id_number.upper())

    if normalized_id in SEEN_IDENTITIES:
        previous_name = SEEN_IDENTITIES[normalized_id]

        return {
            "status": "detected",
            "id_number": id_number,
            "previous_name": previous_name,
            "reason": "The extracted ID number has already been associated with a previous submission."
        }

    SEEN_IDENTITIES[normalized_id] = identity.get("name")

    return {
        "status": "not_detected",
        "id_number": id_number,
        "reason": "The extracted ID number has not been seen in previous submissions."
    }


def check_image_quality(contents):
    try:
        image_array = np.frombuffer(contents, dtype=np.uint8)
        image = cv2.imdecode(image_array, cv2.IMREAD_GRAYSCALE)

        if image is None:
            return {
                "status": "failed",
                "blur_score": 0,
                "brightness": 0,
                "reason": "Image could not be decoded."
            }

        height, width = image.shape

        # Laplacian variance is a common blur indicator.
        blur_score = float(cv2.Laplacian(image, cv2.CV_64F).var())

        brightness = float(np.mean(image))

        problems = []

        if width < 700 or height < 400:
            problems.append("image resolution is low")

        if blur_score < 60:
            problems.append("image appears blurry")

        if brightness < 35:
            problems.append("image is too dark")

        if brightness > 235:
            problems.append("image is overexposed")

        if problems:
            return {
                "status": "failed",
                "width": width,
                "height": height,
                "blur_score": round(blur_score, 2),
                "brightness": round(brightness, 2),
                "reason": "; ".join(problems)
            }

        return {
            "status": "passed",
            "width": width,
            "height": height,
            "blur_score": round(blur_score, 2),
            "brightness": round(brightness, 2),
            "reason": "Image quality is sufficient for automated processing."
        }

    except Exception as error:
        return {
            "status": "review",
            "reason": f"Image quality check could not be completed: {error}"
        }


def check_tamper_risk(contents):
    """
    Conservative tamper-risk analysis.

    This does NOT prove that a document is fake.
    It combines several weak signals and routes suspicious
    documents to manual review.
    """

    signals = []

    try:
        image = Image.open(__import__("io").BytesIO(contents))

        # -------------------------------------------------
        # 1. Metadata analysis
        # -------------------------------------------------

        exif = image.getexif()

        if exif:
            editing_software = []

            for key, value in exif.items():
                if isinstance(value, str):
                    value_lower = value.lower()

                    if any(
                        word in value_lower
                        for word in [
                            "photoshop",
                            "gimp",
                            "illustrator",
                            "canva",
                            "paint.net",
                        ]
                    ):
                        editing_software.append(value)

            if editing_software:
                signals.append(
                    "editing software metadata detected"
                )

        # -------------------------------------------------
        # 2. JPEG recompression / ELA-style signal
        # -------------------------------------------------

        if image.format == "JPEG":
            import io

            original = image.convert("RGB")

            buffer = io.BytesIO()

            original.save(
                buffer,
                format="JPEG",
                quality=90
            )

            buffer.seek(0)

            recompressed = Image.open(buffer).convert("RGB")

            original_array = np.asarray(original).astype(np.int16)
            recompressed_array = np.asarray(
                recompressed
            ).astype(np.int16)

            difference = np.abs(
                original_array - recompressed_array
            )

            ela_score = float(np.mean(difference))

            if ela_score > 18:
                signals.append(
                    f"JPEG recompression anomaly detected (ELA score {ela_score:.2f})"
                )

        # -------------------------------------------------
        # 3. Image structure sanity check
        # -------------------------------------------------

        width, height = image.size

        if width < 700 or height < 400:
            signals.append(
                "document resolution is unusually low"
            )

        # Extremely unusual aspect ratios can indicate
        # cropping or incomplete document capture.
        aspect_ratio = width / height

        if aspect_ratio < 0.5 or aspect_ratio > 3.5:
            signals.append(
                "unusual document aspect ratio detected"
            )

    except Exception:
        signals.append(
            "document structure could not be fully inspected"
        )

    # -----------------------------------------------------
    # Risk decision
    # -----------------------------------------------------

    if signals:
        return {
            "status": "review",
            "risk": "medium",
            "signals": signals,
            "reason": (
                "Potential document manipulation or "
                "structural anomalies were detected; "
                "manual review is recommended."
            )
        }

    return {
        "status": "passed",
        "risk": "low",
        "signals": [],
        "reason": (
            "No significant tampering-risk signals "
            "were detected by the available checks."
        )
    }

def calculate_confidence(
    ocr_result,
    quality_result,
    tamper_result,
    duplicate_result,
    identity_duplicate_result,
    eligibility_result,
    name_match,
    face_match_result
):
    score = 0.50

    if ocr_result.get("fields", {}).get("name"):
        score += 0.10

    if ocr_result.get("fields", {}).get("date_of_birth"):
        score += 0.10

    if ocr_result.get("fields", {}).get("id_number"):
        score += 0.10

    if quality_result.get("status") == "passed":
        score += 0.05
    elif quality_result.get("status") == "failed":
        score -= 0.20

    if tamper_result.get("risk") == "low":
        score += 0.05
    elif tamper_result.get("risk") == "medium":
        score -= 0.10

    if duplicate_result.get("status") == "not_detected":
        score += 0.05
    else:
        score -= 0.25

    if identity_duplicate_result.get("status") == "not_detected":
        score += 0.05
    elif identity_duplicate_result.get("status") == "detected":
        score -= 0.25

    if eligibility_result.get("status") == "passed":
        score += 0.05
    elif eligibility_result.get("status") == "failed":
        score -= 0.25

    if name_match is True:
        score += 0.05
    elif name_match is False:
        score -= 0.15

    if face_match_result.get("status") == "passed":
        score += 0.05
    elif face_match_result.get("status") == "review":
        score -= 0.20

    return round(max(0.0, min(0.99, score)), 2)


def determine_decision(
    quality_result,
    tamper_result,
    duplicate_result,
    identity_duplicate_result,
    eligibility_result,
    ocr_result,
    name_match,
    face_match_result
):
    fields = ocr_result.get("fields", {})

    if duplicate_result.get("status") == "detected":
        return "REVIEW"

    if identity_duplicate_result.get("status") == "detected":
        return "REVIEW"

    if quality_result.get("status") == "failed":
        return "REVIEW"

    if tamper_result.get("risk") == "medium":
        return "REVIEW"

    if eligibility_result.get("status") == "failed":
        return "INELIGIBLE"

    if eligibility_result.get("status") == "review":
        return "REVIEW"

    if not fields.get("name") or not fields.get("date_of_birth"):
        return "REVIEW"

    if name_match is False:
        return "REVIEW"

    if face_match_result.get("status") == "review":
        return "REVIEW"

    return "ELIGIBLE"


def build_reason(
    decision,
    quality_result,
    tamper_result,
    duplicate_result,
    identity_duplicate_result,
    eligibility_result,
    name_match,
    face_match_result
):
    reasons = []

    if decision == "ELIGIBLE":
        reasons.append("identity fields were successfully extracted")

        if quality_result.get("status") == "passed":
            reasons.append("image quality passed")

        if duplicate_result.get("status") == "not_detected":
            reasons.append("no identical duplicate was detected")

        if identity_duplicate_result.get("status") == "not_detected":
            reasons.append("no identity reuse was detected")

        if tamper_result.get("risk") == "low":
            reasons.append("no basic tampering indicators were detected")

        if eligibility_result.get("status") == "passed":
            reasons.append("age eligibility check passed")

        if name_match is True:
            reasons.append("registration name matches the extracted name")

        if face_match_result.get("status") == "passed":
            reasons.append("selfie face matches the identity document")
        elif face_match_result.get("status") == "not_provided":
            reasons.append("face verification was skipped because no selfie was provided")

        return "Automated verification passed because " + ", ".join(reasons) + "."

    if decision == "INELIGIBLE":
        return eligibility_result.get(
            "reason",
            "The registration did not satisfy the configured eligibility rules."
        )

    # REVIEW reasons are collected together so important signals
    # such as face mismatch are not hidden by duplicate detection.
    if duplicate_result.get("status") == "detected":
        reasons.append("the document matches a previously submitted file")

    if identity_duplicate_result.get("status") == "detected":
        reasons.append("the extracted identity has already been associated with a previous submission")

    if quality_result.get("status") == "failed":
        reasons.append("document image quality is insufficient")

    if tamper_result.get("risk") == "medium":
        reasons.append("potential document-tampering indicators were detected")

    if name_match is False:
        reasons.append("registration name does not sufficiently match the extracted document name")

    if face_match_result.get("status") == "review":
        reasons.append("selfie face does not sufficiently match the identity document")

    if reasons:
        return (
            "Manual review is required because "
            + ", ".join(reasons)
            + "."
        )

    return "The system could not establish sufficient confidence for automatic approval; manual review is recommended."
def verify_document(
    contents,
    ocr_result,
    registration_name=None,
    min_age=18,
    max_age=100,
    face_match_result=None
):
    if face_match_result is None:
        face_match_result = {
            "status": "not_provided",
            "match": None,
            "similarity": None,
            "reason": "Selfie was not provided; face verification was skipped."
        }

    quality_result = check_image_quality(contents)

    tamper_result = check_tamper_risk(contents)

    duplicate_result = check_duplicate(contents)

    identity_duplicate_result = check_identity_duplicate(
        ocr_result.get("fields", {})
    )

    eligibility_result = check_eligibility(
        ocr_result.get("fields", {}).get("date_of_birth"),
        min_age,
        max_age
    )

    extracted_name = ocr_result.get("fields", {}).get("name")

    name_match = names_match(
        extracted_name,
        registration_name
    )

    decision = determine_decision(
        quality_result,
        tamper_result,
        duplicate_result,
        identity_duplicate_result,
        eligibility_result,
        ocr_result,
        name_match,
        face_match_result
    )

    confidence = calculate_confidence(
        ocr_result,
        quality_result,
        tamper_result,
        duplicate_result,
        identity_duplicate_result,
        eligibility_result,
        name_match,
        face_match_result
    )

    reason = build_reason(
        decision,
        quality_result,
        tamper_result,
        duplicate_result,
        identity_duplicate_result,
        eligibility_result,
        name_match,
        face_match_result
    )

    return {
        "decision": decision,
        "confidence": confidence,
        "reason": reason,

        "identity": ocr_result.get("fields", {}),

        "checks": {
            "ocr": "passed" if (
                ocr_result.get("fields", {}).get("name")
                and ocr_result.get("fields", {}).get("date_of_birth")
            ) else "review",

            "quality": quality_result,
            "tamper_risk": tamper_result,
            "duplicate": duplicate_result,
            "identity_duplicate": identity_duplicate_result,
            "eligibility": eligibility_result,
            "name_match": name_match,
            "face_match": face_match_result
        }
    }