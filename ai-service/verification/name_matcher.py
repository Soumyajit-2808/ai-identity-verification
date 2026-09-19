"""
Advanced Name Matching Engine
Combines token sorting, initials matching, token overlap, and Levenshtein/Jaro-Winkler distances.
"""

import re
from typing import List, Dict, Any, Tuple
from pydantic import BaseModel


class NameMatchResult(BaseModel):
    matched: bool
    score: float
    method: str
    normalized_extracted: str
    normalized_registration: str
    threshold: float
    details: Dict[str, Any] = {}


HONORIFICS = {"MR", "MS", "MRS", "DR", "PROF", "SHRI", "SMT", "KUMAR", "KUMARI"}


def clean_name_tokens(name: str) -> List[str]:
    if not name:
        return []
    # Uppercase and remove special characters except spaces
    cleaned = re.sub(r"[^A-Za-z\s]", " ", name.upper())
    tokens = [t for t in cleaned.split() if t]
    # Filter out pure honorific prefixes
    if tokens and tokens[0] in HONORIFICS:
        tokens = tokens[1:]
    return tokens


def levenshtein_distance(s1: str, s2: str) -> int:
    """Standard Levenshtein edit distance."""
    if len(s1) < len(s2):
        return levenshtein_distance(s2, s1)
    if len(s2) == 0:
        return len(s1)

    previous_row = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        current_row = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = previous_row[j + 1] + 1
            deletions = current_row[j] + 1
            substitutions = previous_row[j] + (c1 != c2)
            current_row.append(min(insertions, deletions, substitutions))
        previous_row = current_row

    return previous_row[-1]


def jaro_winkler_similarity(s1: str, s2: str) -> float:
    """Calculate Jaro-Winkler metric for OCR and typo tolerance."""
    if s1 == s2:
        return 1.0
    len1, len2 = len(s1), len(s2)
    if len1 == 0 or len2 == 0:
        return 0.0

    match_distance = max(len1, len2) // 2 - 1
    s1_matches = [False] * len1
    s2_matches = [False] * len2
    matches = 0

    for i in range(len1):
        start = max(0, i - match_distance)
        end = min(i + match_distance + 1, len2)
        for j in range(start, end):
            if s2_matches[j]:
                continue
            if s1[i] != s2[j]:
                continue
            s1_matches[i] = True
            s2_matches[j] = True
            matches += 1
            break

    if matches == 0:
        return 0.0

    # Count transpositions
    k = 0
    transpositions = 0
    for i in range(len1):
        if not s1_matches[i]:
            continue
        while not s2_matches[k]:
            k += 1
        if s1[i] != s2[k]:
            transpositions += 1
        k += 1

    jaro = (
        (matches / len1) +
        (matches / len2) +
        ((matches - transpositions / 2) / matches)
    ) / 3.0

    # Winkler prefix bonus
    prefix_length = 0
    for i in range(min(4, min(len1, len2))):
        if s1[i] == s2[i]:
            prefix_length += 1
        else:
            break

    return jaro + prefix_length * 0.1 * (1.0 - jaro)


def check_initials_match(tokens1: List[str], tokens2: List[str]) -> Tuple[bool, float]:
    """
    Check if one name is an abbreviated initial version of the other.
    E.g., ['R', 'SHARMA'] vs ['RAHUL', 'SHARMA']
    """
    if len(tokens1) != len(tokens2):
        return False, 0.0

    all_match = True
    initial_matches = 0

    for t1, t2 in zip(tokens1, tokens2):
        if t1 == t2:
            continue
        elif len(t1) == 1 and t2.startswith(t1):
            initial_matches += 1
        elif len(t2) == 1 and t1.startswith(t2):
            initial_matches += 1
        else:
            all_match = False
            break

    if all_match and initial_matches > 0:
        # Score scaled by proportion of full matches vs initials
        score = 0.85 + (0.10 * (1.0 - (initial_matches / len(tokens1))))
        return True, score

    return False, 0.0


def match_names(
    extracted_name: str,
    registration_name: str,
    threshold: float = 0.75,
    strict: bool = False
) -> NameMatchResult:
    """
    Evaluate similarity between document-extracted name and participant registration name.
    """
    if not extracted_name or not registration_name:
        return NameMatchResult(
            matched=False,
            score=0.0,
            method="MISSING_INPUT",
            normalized_extracted=extracted_name or "",
            normalized_registration=registration_name or "",
            threshold=threshold,
            details={"reason": "One or both names are empty or missing."}
        )

    t1 = clean_name_tokens(extracted_name)
    t2 = clean_name_tokens(registration_name)

    norm1 = " ".join(t1)
    norm2 = " ".join(t2)

    # 1. Exact string match after normalization
    if norm1 == norm2:
        return NameMatchResult(
            matched=True,
            score=1.0,
            method="EXACT_MATCH",
            normalized_extracted=norm1,
            normalized_registration=norm2,
            threshold=threshold,
            details={"match_type": "exact"}
        )

    # 2. Token-sorted match (handles "Sharma Rahul" vs "Rahul Sharma")
    if sorted(t1) == sorted(t2):
        return NameMatchResult(
            matched=True,
            score=0.98,
            method="TOKEN_REORDER",
            normalized_extracted=norm1,
            normalized_registration=norm2,
            threshold=threshold,
            details={"match_type": "order_permutation"}
        )

    # 3. Initials matching (e.g. "R. Sharma" vs "Rahul Sharma")
    is_initials, initials_score = check_initials_match(t1, t2)
    if is_initials:
        return NameMatchResult(
            matched=True,
            score=round(initials_score, 2),
            method="INITIALS_MATCH",
            normalized_extracted=norm1,
            normalized_registration=norm2,
            threshold=threshold,
            details={"match_type": "initial_expansion"}
        )

    # 4. Token Overlap / Jaccard similarity (handles missing middle names)
    set1, set2 = set(t1), set(t2)
    intersection = set1.intersection(set2)
    union = set1.union(set2)
    jaccard = len(intersection) / max(len(union), 1)

    # Containment (one is a strict subset of the other, e.g. "Rahul Kumar Sharma" vs "Rahul Sharma")
    is_subset = set1.issubset(set2) or set2.issubset(set1)
    if is_subset and len(intersection) >= 2:
        containment_score = 0.90
        return NameMatchResult(
            matched=True,
            score=containment_score,
            method="SUBSET_MATCH",
            normalized_extracted=norm1,
            normalized_registration=norm2,
            threshold=threshold,
            details={"shared_tokens": list(intersection)}
        )

    # 5. Jaro-Winkler string similarity (robust to character typos & OCR confusion)
    jw_score = jaro_winkler_similarity(norm1, norm2)

    # In strict mode, only allow high threshold (>= 0.90)
    effective_threshold = 0.90 if strict else threshold
    final_score = max(jaccard, jw_score)
    matched = final_score >= effective_threshold

    return NameMatchResult(
        matched=matched,
        score=round(final_score, 2),
        method="FUZZY_COMPOSITE",
        normalized_extracted=norm1,
        normalized_registration=norm2,
        threshold=effective_threshold,
        details={
            "jaccard_score": round(jaccard, 2),
            "jaro_winkler_score": round(jw_score, 2),
            "levenshtein_distance": levenshtein_distance(norm1, norm2),
        }
    )
