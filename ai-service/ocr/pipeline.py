"""
OCR Pipeline Orchestrator
Coordinates primary (AWS Textract) and secondary (Tesseract) OCR providers.
"""

from typing import Optional
from ocr.base import OCRResult
from ocr.textract_provider import TextractOCRProvider
from ocr.tesseract_provider import TesseractOCRProvider


class OCRPipeline:
    def __init__(self):
        self.textract_provider = TextractOCRProvider()
        self.tesseract_provider = TesseractOCRProvider()

    def process(self, image_bytes: bytes) -> OCRResult:
        """
        Execute OCR with fallback cascade:
        1. AWS Textract (if configured)
        2. Tesseract local engine (fallback)
        """
        # 1. Attempt AWS Textract if credentials are present
        if self.textract_provider.is_available():
            result = self.textract_provider.extract_text(image_bytes)
            if result.success and result.raw_text.strip():
                return result

        # 2. Fall back to local Tesseract OCR
        if self.tesseract_provider.is_available():
            result = self.tesseract_provider.extract_text(image_bytes)
            if result.success:
                return result

        # 3. Neither succeeded
        return OCRResult(
            raw_text="",
            engine="none",
            success=False,
            error_message="No operational OCR engine could extract text from the document."
        )


# Global singleton instance
pipeline = OCRPipeline()


def run_ocr(image_bytes: bytes) -> OCRResult:
    return pipeline.process(image_bytes)
