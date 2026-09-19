"""
Identity Normalization & Document Field Extraction
Provides robust date parsing, semantic validation, and document-specific format rules.
"""

import re
from datetime import date, datetime
from typing import Optional, List, Tuple, Dict, Any
from pydantic import BaseModel


class ExtractedIdentity(BaseModel):
    name: Optional[str] = None
    date_of_birth: Optional[str] = None       # Standardized YYYY-MM-DD
    raw_date_of_birth: Optional[str] = None   # Original string extracted
    calculated_age: Optional[int] = None
    id_number: Optional[str] = None
    id_type: str = "UNKNOWN"
    institution: Optional[str] = None


# Known document header lines to ignore when extracting personal names
IGNORE_NAME_PATTERNS = [
    r"GOVERNMENT OF INDIA",
    r"UNIQUE IDENTIFICATION AUTHORITY OF INDIA",
    r"UIDAI",
    r"INCOME TAX DEPARTMENT",
    r"ELECTION COMMISSION OF INDIA",
    r"DRIVING LICEN[SC]E",
    r"IDENTITY CARD",
    r"STUDENT ID",
    r"COLLEGE ID",
    r"REPUBLIC OF INDIA",
    r"TRANSPORT DEPARTMENT",
]


def clean_text(text: str) -> str:
    """Normalize whitespace and clean non-printable characters."""
    if not text:
        return ""
    text = re.sub(r"[\r\t]+", " ", text)
    text = re.sub(r" +", " ", text)
    return text.strip()


def parse_date_of_birth(text: str) -> Tuple[Optional[str], Optional[int], Optional[str]]:
    """
    Search for date-of-birth patterns, validate calendar semantics,
    and calculate accurate age relative to today's date.
    Returns: (iso_date_string, calculated_age, raw_matched_string)
    """
    # 1. Regex patterns covering common international and Indian date formats
    patterns = [
        # Explicitly labeled: DOB: 15/08/2004, Date of Birth: 1999-04-12
        r"(?:DOB|DATE OF BIRTH|BIRTH DATE|D\.O\.B)[\s:\-_]+(\d{1,2}[/\-\.]\d{1,2}[/\-\.]\d{2,4})",
        r"(?:DOB|DATE OF BIRTH|BIRTH DATE|D\.O\.B)[\s:\-_]+(\d{4}[/\-\.]\d{1,2}[/\-\.]\d{1,2})",
        # DD/MM/YYYY or DD-MM-YYYY
        r"\b([0-3]?\d[/\-\.][0-1]?\d[/\-\.](?:19|20)\d{2})\b",
        # YYYY/MM/DD or YYYY-MM-DD
        r"\b((?:19|20)\d{2}[/\-\.][0-1]?\d[/\-\.][0-3]?\d)\b",
        # Textual month formats: 15 Aug 2004, August 15, 2004
        r"\b([0-3]?\d[\s\-\.](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s\-\.](?:19|20)\d{2})\b",
    ]

    found_matches = []
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.IGNORECASE):
            found_matches.append(match.group(1).strip(" .,"))

    # Formats to attempt parsing
    date_formats = [
        "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y",
        "%Y/%m/%d", "%Y-%m-%d", "%Y.%m.%d",
        "%m/%d/%Y", "%m-%d-%Y",
        "%d %b %Y", "%d-%b-%Y", "%d %B %Y",
        "%b %d, %Y", "%B %d, %Y",
    ]

    current_year = date.today().year

    for match_str in found_matches:
        # Normalize separators
        clean_match = re.sub(r"[\.\-]", "/", match_str)
        # Try both normalized and original strings
        candidate_strings = [clean_match, match_str]

        for cand in candidate_strings:
            for fmt in date_formats:
                try:
                    parsed_date = datetime.strptime(cand, fmt).date()

                    # Semantic validity: year must be reasonable (1900 to present)
                    if parsed_date.year < 1900 or parsed_date.year > current_year:
                        continue

                    # Date cannot be in the future
                    today = date.today()
                    if parsed_date > today:
                        continue

                    # Accurate age calculation
                    age = today.year - parsed_date.year
                    if (today.month, today.day) < (parsed_date.month, parsed_date.day):
                        age -= 1

                    # Reasonable human age check (0 to 125)
                    if 0 <= age <= 125:
                        iso_str = parsed_date.strftime("%Y-%m-%d")
                        return iso_str, age, match_str

                except ValueError:
                    continue

    return None, None, None


def extract_id_type_and_number(text: str) -> Tuple[Optional[str], str]:
    """
    Extract standardized document numbers using document-specific format validation.
    Returns: (id_number, id_type)
    """
    upper = text.upper()

    # 1. PAN Card: 5 uppercase letters, 4 digits, 1 letter (e.g. ABCDE1234F)
    pan_match = re.search(r"\b([A-Z]{5}[0-9]{4}[A-Z])\b", upper)
    if pan_match:
        return pan_match.group(1), "PAN"

    # 2. Aadhaar Card: 12 digits formatted as 4-4-4
    aadhaar_spaced = re.search(r"\b(\d{4}\s\d{4}\s\d{4})\b", text)
    if aadhaar_spaced and ("AADHAAR" in upper or "UIDAI" in upper or "MERA AADHAAR" in upper):
        return aadhaar_spaced.group(1), "AADHAAR"

    # 3. Passport: 1 letter followed by 7 digits (Indian / standard format)
    passport_match = re.search(r"\b([A-PR-WYa-pr-wy][1-9]\d{6})\b", text)
    if passport_match and "PASSPORT" in upper:
        return passport_match.group(1).upper(), "PASSPORT"

    # 4. Driving License: DL-XX-XXXX-XXXXXXX or standard 15-16 alphanumeric
    dl_match = re.search(r"\b([A-Z]{2}[0-9]{2}[A-Z0-9]{11,12})\b", upper)
    if dl_match and ("DRIVING" in upper or "LICENCE" in upper or "LICENSE" in upper):
        return dl_match.group(1), "DRIVING_LICENSE"

    # 5. Voter ID (EPIC): 3 letters followed by 7 digits (e.g. ABC1234567)
    voter_match = re.search(r"\b([A-Z]{3}[0-9]{7})\b", upper)
    if voter_match and ("ELECTION" in upper or "VOTER" in upper or "EPIC" in upper):
        return voter_match.group(1), "VOTER_ID"

    # 6. Student ID: Roll / Registration / Student ID patterns
    student_match = re.search(r"(?:STUDENT\s+ID|ROLL\s+NO|ENROLLMENT|REG(?:ISTRATION)?\s+NO)[\s:\-_]+([A-Z0-9\-]{4,15})\b", upper)
    if student_match:
        return student_match.group(1), "STUDENT_ID"

    # 7. Generic Fallback ID Number
    generic_patterns = [
        r"\b([A-Z]{2,4}[0-9]{6,10})\b",
        r"\b([0-9]{4}\s[0-9]{4}\s[0-9]{4})\b",
        r"\b([A-Z0-9]{8,14})\b",
    ]
    for pat in generic_patterns:
        m = re.search(pat, upper)
        if m:
            detected_type = "UNKNOWN"
            if "STUDENT" in upper or "COLLEGE" in upper or "UNIVERSITY" in upper:
                detected_type = "STUDENT_ID"
            elif "AADHAAR" in upper:
                detected_type = "AADHAAR"
            return m.group(1), detected_type

    # Determine type by keywords if number not extracted
    if "AADHAAR" in upper or "UIDAI" in upper:
        return None, "AADHAAR"
    if "PAN" in upper:
        return None, "PAN"
    if "PASSPORT" in upper:
        return None, "PASSPORT"
    if "DRIVING" in upper:
        return None, "DRIVING_LICENSE"
    if "STUDENT" in upper or "COLLEGE" in upper or "UNIVERSITY" in upper:
        return None, "STUDENT_ID"

    return None, "UNKNOWN"


def extract_name(text: str, lines: List[str] = None) -> Optional[str]:
    """
    Extract a person's name using multi-pass heuristic label detection and noise filtration.
    """
    if not lines:
        lines = [line.strip() for line in text.splitlines() if line.strip()]

    # Pass 1: Look for explicit NAME labels
    label_patterns = [
        r"\b(?:FULL\s+)?NAME\s*[:\-]\s*(.*)$",
        r"\bNAME\s+OF\s+(?:CARDHOLDER|HOLDER|STUDENT)\s*[:\-]\s*(.*)$",
        r"\bSTUDENT\s+NAME\s*[:\-]\s*(.*)$",
    ]

    for index, line in enumerate(lines):
        for pat in label_patterns:
            match = re.search(pat, line, re.IGNORECASE)
            if match:
                val = match.group(1).strip(" :-_#*")
                val = clean_name_value(val)
                if is_plausible_name(val):
                    return val

                # If the value was empty on the same line, check the next line
                if index + 1 < len(lines):
                    next_line = lines[index + 1].strip(" :-_#*")
                    if not is_header_or_field_label(next_line):
                        cleaned = clean_name_value(next_line)
                        if is_plausible_name(cleaned):
                            return cleaned

    # Pass 2: In PAN cards, the cardholder's name typically appears right after the Income Tax heading
    for index, line in enumerate(lines):
        if "INCOME TAX DEPARTMENT" in line.upper() or "GOVT. OF INDIA" in line.upper():
            # Look at the next non-header line
            for j in range(index + 1, min(index + 4, len(lines))):
                candidate = lines[j].strip(" :-_#*")
                if not is_header_or_field_label(candidate):
                    cleaned = clean_name_value(candidate)
                    if is_plausible_name(cleaned):
                        return cleaned

    # Pass 3: In student IDs, look for lines with 2-4 capitalized words that are not headers
    for line in lines:
        if not is_header_or_field_label(line):
            cleaned = clean_name_value(line)
            words = cleaned.split()
            if 2 <= len(words) <= 4 and all(w.isalpha() for w in words):
                if is_plausible_name(cleaned):
                    return cleaned

    return None


def clean_name_value(val: str) -> str:
    if not val:
        return ""
    # Remove honorifics
    val = re.sub(r"^(?:MR|MS|MRS|DR|PROF|SHRI|SMT)\.?\s+", "", val, flags=re.IGNORECASE)
    # Remove non-alpha except space, apostrophe, hyphen
    val = re.sub(r"[^A-Za-z\s'\-]", " ", val)
    val = re.sub(r"\s+", " ", val).strip()
    return val.title()


def is_plausible_name(val: str) -> bool:
    if not val or len(val) < 3 or len(val) > 70:
        return False
    words = val.split()
    if not words:
        return False
    # A name should consist primarily of alphabetic words
    for w in words:
        if not w.isalpha() and not all(c.isalpha() or c in "'-" for c in w):
            return False
    # Avoid single-letter garbage
    if len(words) == 1 and len(words[0]) < 3:
        return False
    return True


def is_header_or_field_label(line: str) -> bool:
    upper = line.upper().strip()
    if any(re.search(pat, upper) for pat in IGNORE_NAME_PATTERNS):
        return True
    label_starters = [
        "DOB", "DATE OF BIRTH", "ID", "STUDENT ID", "FATHER", "DEPARTMENT",
        "VALID", "EXPIRY", "ISSUE", "GENDER", "SEX", "SIGNATURE", "ADDRESS",
        "YEAR", "BRANCH", "COURSE", "SEM", "BLOOD", "PHOTO",
    ]
    return any(upper.startswith(prefix) for prefix in label_starters)


def extract_institution(text: str, lines: List[str] = None) -> Optional[str]:
    """Find university, college, or institute name."""
    if not lines:
        lines = [line.strip() for line in text.splitlines() if line.strip()]

    keywords = ["UNIVERSITY", "COLLEGE", "INSTITUTE", "ACADEMY", "CAMPUS", "SCHOOL OF"]
    for line in lines:
        upper = line.upper()
        if any(kw in upper for kw in keywords):
            # Clean up line
            cleaned = re.sub(r"[^A-Za-z0-9\s,\-\.&]", " ", line).strip()
            if len(cleaned) >= 5:
                return cleaned

    return None


def normalize_identity_document(raw_text: str, lines: List[str] = None) -> ExtractedIdentity:
    """
    Main extraction pipeline: cleans text and extracts all normalized identity fields.
    """
    if not lines:
        lines = [line.strip() for line in raw_text.splitlines() if line.strip()]

    iso_dob, age, raw_dob = parse_date_of_birth(raw_text)
    id_num, id_type = extract_id_type_and_number(raw_text)
    name = extract_name(raw_text, lines)
    institution = extract_institution(raw_text, lines)

    return ExtractedIdentity(
        name=name,
        date_of_birth=iso_dob,
        raw_date_of_birth=raw_dob,
        calculated_age=age,
        id_number=id_num,
        id_type=id_type,
        institution=institution,
    )
