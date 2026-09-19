"""
Local Tesseract OCR Provider
"""

import os
import shutil
from io import BytesIO
from PIL import Image, ImageEnhance, ImageFilter
import pytesseract
from ocr.base import BaseOCRProvider, OCRResult


class TesseractOCRProvider(BaseOCRProvider):
    def __init__(self):
        self._configure_binary_path()

    def _configure_binary_path(self):
        # 1. Respect explicit env var
        env_cmd = os.getenv("TESSERACT_CMD")
        if env_cmd and os.path.exists(env_cmd):
            pytesseract.pytesseract.tesseract_cmd = env_cmd
            return

        # 2. Check if tesseract is in system PATH
        path_binary = shutil.which("tesseract")
        if path_binary:
            pytesseract.pytesseract.tesseract_cmd = path_binary
            return

        # 3. Standard Windows fallback locations
        windows_paths = [
            r"C:\Program Files\Tesseract-OCR\tesseract.exe",
            r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
            os.path.expandvars(r"%LOCALAPPDATA%\Programs\Tesseract-OCR\tesseract.exe"),
        ]
        for p in windows_paths:
            if os.path.exists(p):
                pytesseract.pytesseract.tesseract_cmd = p
                return

    def is_available(self) -> bool:
        cmd = pytesseract.pytesseract.tesseract_cmd
        return bool(cmd and (os.path.exists(cmd) or shutil.which(cmd)))

    def preprocess_image(self, image: Image.Image) -> Image.Image:
        """
        Preprocess document image to optimize character edge detection and contrast.
        """
        # Grayscale
        gray = image.convert("L")

        # Contrast enhancement
        enhanced = ImageEnhance.Contrast(gray).enhance(2.0)

        # Subtle sharpening
        sharpened = enhanced.filter(ImageFilter.SHARPEN)

        # Scale up small documents to reasonable OCR resolution
        w, h = sharpened.size
        if w < 1600:
            scale = 1600 / max(w, 1)
            sharpened = sharpened.resize(
                (int(w * scale), int(h * scale)),
                Image.Resampling.LANCZOS
            )

        return sharpened

    def extract_text(self, image_bytes: bytes) -> OCRResult:
        if not self.is_available():
            return OCRResult(
                raw_text="",
                engine="tesseract",
                success=False,
                error_message="Tesseract OCR executable not found on system."
            )

        try:
            image = Image.open(BytesIO(image_bytes))
            processed = self.preprocess_image(image)

            # PSM 6: Assume a single uniform block of text
            raw_text = pytesseract.image_to_string(processed, config="--psm 6")
            lines = [line.strip() for line in raw_text.splitlines() if line.strip()]

            return OCRResult(
                raw_text=raw_text.strip(),
                engine="tesseract",
                lines=lines,
                success=True
            )
        except Exception as err:
            return OCRResult(
                raw_text="",
                engine="tesseract",
                success=False,
                error_message=f"Tesseract extraction error: {str(err)}"
            )
