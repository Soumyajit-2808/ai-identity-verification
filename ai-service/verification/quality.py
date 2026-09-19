"""
Document Image Quality Assessment Engine
Analyzes sharpness, lighting, contrast, glare, and resolution to produce granular evidence.
"""

from typing import List, Dict, Any
import cv2
import numpy as np
from pydantic import BaseModel


class QualityResult(BaseModel):
    status: str  # "PASSED", "REVIEW", "FAILED"
    blur_score: float
    brightness_score: float
    contrast_score: float
    glare_ratio: float
    width: int
    height: int
    aspect_ratio: float
    issues: List[str] = []
    reason: str


# Documented default thresholds
THRESHOLDS = {
    "min_width": 600,
    "min_height": 350,
    "blur_fail": 30.0,       # Severe blur
    "blur_review": 65.0,     # Mild blur
    "brightness_dark": 35.0, # Too dark
    "brightness_glare": 235.0, # Blown out
    "min_contrast": 25.0,    # Flat / low contrast image
    "glare_pixel_ratio": 0.15, # >15% of pixels completely saturated
    "min_aspect_ratio": 0.45,
    "max_aspect_ratio": 3.20,
}


def analyze_image_quality(image_bytes: bytes, custom_thresholds: Dict[str, float] = None) -> QualityResult:
    """
    Compute multi-dimensional quality evidence on the document image binary.
    """
    t = {**THRESHOLDS, **(custom_thresholds or {})}

    try:
        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        gray = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)

        if gray is None:
            return QualityResult(
                status="FAILED",
                blur_score=0.0,
                brightness_score=0.0,
                contrast_score=0.0,
                glare_ratio=0.0,
                width=0,
                height=0,
                aspect_ratio=0.0,
                issues=["Image could not be decoded or is corrupted."],
                reason="The uploaded file could not be read as a valid image."
            )

        h, w = gray.shape
        aspect = round(w / max(h, 1), 2)

        # 1. Blur via Laplacian variance
        laplacian_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        blur_score = round(laplacian_var, 2)

        # 2. Brightness via mean intensity
        brightness = round(float(np.mean(gray)), 2)

        # 3. Contrast via standard deviation
        contrast = round(float(np.std(gray)), 2)

        # 4. Glare detection (proportion of pixels > 250)
        saturated_pixels = np.count_nonzero(gray >= 250)
        total_pixels = w * h
        glare_ratio = round(saturated_pixels / max(total_pixels, 1), 4)

        issues = []
        is_severe = False

        # Evaluate resolution
        if w < t["min_width"] or h < t["min_height"]:
            issues.append(f"Low resolution ({w}x{h}, minimum recommended is {t['min_width']}x{t['min_height']})")

        # Evaluate aspect ratio (extreme cropping)
        if aspect < t["min_aspect_ratio"] or aspect > t["max_aspect_ratio"]:
            issues.append(f"Unusual document aspect ratio ({aspect}:1)")

        # Evaluate blur
        if blur_score < t["blur_fail"]:
            issues.append(f"Severe blur detected (sharpness score {blur_score} < {t['blur_fail']})")
            is_severe = True
        elif blur_score < t["blur_review"]:
            issues.append(f"Mild blur detected (sharpness score {blur_score} < {t['blur_review']})")

        # Evaluate lighting
        if brightness < t["brightness_dark"]:
            issues.append(f"Image is underexposed/too dark (brightness {brightness})")
        elif brightness > t["brightness_glare"]:
            issues.append(f"Image is overexposed/too bright (brightness {brightness})")

        # Evaluate contrast
        if contrast < t["min_contrast"]:
            issues.append(f"Low contrast (contrast score {contrast})")

        # Evaluate glare
        if glare_ratio > t["glare_pixel_ratio"]:
            issues.append(f"Glare/flash reflection detected on {int(glare_ratio * 100)}% of document surface")

        # Determine status
        if is_severe:
            status = "FAILED"
            reason = f"Image quality failed: {'; '.join(issues)}."
        elif issues:
            status = "REVIEW"
            reason = f"Image quality requires review: {'; '.join(issues)}."
        else:
            status = "PASSED"
            reason = "Document image sharpness, resolution, lighting, and contrast meet quality standards."

        return QualityResult(
            status=status,
            blur_score=blur_score,
            brightness_score=brightness,
            contrast_score=contrast,
            glare_ratio=glare_ratio,
            width=w,
            height=h,
            aspect_ratio=aspect,
            issues=issues,
            reason=reason,
        )

    except Exception as err:
        return QualityResult(
            status="REVIEW",
            blur_score=0.0,
            brightness_score=0.0,
            contrast_score=0.0,
            glare_ratio=0.0,
            width=0,
            height=0,
            aspect_ratio=0.0,
            issues=[f"Quality check error: {str(err)}"],
            reason="Quality analysis could not be fully evaluated due to an internal processing exception."
        )
