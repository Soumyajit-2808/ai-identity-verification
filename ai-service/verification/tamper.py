"""
Document Tamper-Risk Assessment Engine
Heuristic analysis of image metadata, recompression anomalies, and structural integrity.
Explicitly identifies limitations and distinguishes anomaly indicators from forensic authenticity.
"""

import io
from typing import List, Dict, Any, Optional
import numpy as np
from PIL import Image
from pydantic import BaseModel


class TamperResult(BaseModel):
    status: str       # "PASSED" or "REVIEW"
    risk_level: str   # "LOW", "MEDIUM", "HIGH"
    signals: List[str] = []
    ela_score: Optional[float] = None
    editing_tools_detected: List[str] = []
    reason: str
    disclaimer: str = (
        "Tamper-risk analysis evaluates structural and compression anomaly indicators. "
        "It does not provide conclusive forensic proof of forgery or issuer authority validation."
    )


EDITING_SOFTWARE_KEYWORDS = [
    "photoshop", "gimp", "canva", "illustrator", "paint.net", "picsart",
    "snapseed", "pixlr", "affinity", "coreldraw", "photopea", "fotor"
]


def analyze_tamper_risk(image_bytes: bytes) -> TamperResult:
    signals = []
    tools_detected = []
    ela_score = None

    try:
        image = Image.open(io.BytesIO(image_bytes))

        # 1. Metadata Inspection
        try:
            exif_data = image.getexif()
            if exif_data:
                for _, value in exif_data.items():
                    if isinstance(value, str):
                        v_lower = value.lower()
                        for kw in EDITING_SOFTWARE_KEYWORDS:
                            if kw in v_lower:
                                tools_detected.append(value.strip())
                                signals.append(f"Image editor metadata tag found: '{value.strip()}'")
                                break
        except Exception:
            pass  # Non-fatal if EXIF is absent or unparseable

        # 2. JPEG Error Level Analysis (ELA)
        # Compares pixel delta between original image and a fixed 90% recompressed copy
        if image.format == "JPEG" or (len(image_bytes) >= 2 and image_bytes[0] == 0xFF and image_bytes[1] == 0xD8):
            try:
                rgb_img = image.convert("RGB")
                buf = io.BytesIO()
                rgb_img.save(buf, format="JPEG", quality=90)
                buf.seek(0)

                recompressed = Image.open(buf).convert("RGB")
                orig_arr = np.asarray(rgb_img).astype(np.int16)
                recomp_arr = np.asarray(recompressed).astype(np.int16)

                diff = np.abs(orig_arr - recomp_arr)
                ela_score = round(float(np.mean(diff)), 2)

                # Higher delta implies non-uniform compression history (possible localized re-saving)
                if ela_score > 22.0:
                    signals.append(f"High JPEG recompression anomaly score ({ela_score} > 22.0)")
            except Exception:
                pass

        # 3. Structural dimensions & aspect sanity
        w, h = image.size
        aspect = w / max(h, 1)
        if aspect < 0.45 or aspect > 3.50:
            signals.append(f"Extreme aspect ratio ({aspect:.2f}:1) suggests severe cropping or irregular document layout")

        # 4. Synthesize risk outcome
        if len(signals) >= 2 or (tools_detected and ela_score and ela_score > 20.0):
            risk_level = "HIGH"
            status = "REVIEW"
            reason = f"Multiple tampering indicators detected ({len(signals)} signals); manual verification required."
        elif len(signals) == 1:
            risk_level = "MEDIUM"
            status = "REVIEW"
            reason = f"Potential tampering anomaly detected ({signals[0]}); manual inspection advised."
        else:
            risk_level = "LOW"
            status = "PASSED"
            reason = "No basic digital manipulation or compression anomaly signals detected by automated checks."

        return TamperResult(
            status=status,
            risk_level=risk_level,
            signals=signals,
            ela_score=ela_score,
            editing_tools_detected=tools_detected,
            reason=reason,
        )

    except Exception as err:
        return TamperResult(
            status="REVIEW",
            risk_level="MEDIUM",
            signals=[f"Analysis error: {str(err)}"],
            reason="Tamper-risk analysis could not be fully completed due to an image decoding exception."
        )
