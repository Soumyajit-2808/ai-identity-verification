"""
AWS Textract OCR Provider
"""

import os
try:
    import boto3
except ImportError:
    boto3 = None
from ocr.base import BaseOCRProvider, OCRResult


class TextractOCRProvider(BaseOCRProvider):
    def __init__(self):
        self.region = os.getenv("AWS_REGION")
        self.access_key = os.getenv("AWS_ACCESS_KEY_ID")
        self.secret_key = os.getenv("AWS_SECRET_ACCESS_KEY")

    def is_available(self) -> bool:
        return bool(boto3 is not None and self.access_key and self.secret_key and self.region)

    def extract_text(self, image_bytes: bytes) -> OCRResult:
        if not self.is_available():
            return OCRResult(
                raw_text="",
                engine="aws_textract",
                success=False,
                error_message="AWS Textract credentials not configured in environment."
            )

        try:
            client = boto3.client(
                "textract",
                region_name=self.region,
                aws_access_key_id=self.access_key,
                aws_secret_access_key=self.secret_key,
            )

            response = client.detect_document_text(
                Document={"Bytes": image_bytes}
            )

            lines = []
            for block in response.get("Blocks", []):
                if block.get("BlockType") == "LINE":
                    text = block.get("Text")
                    if text:
                        lines.append(text.strip())

            raw_text = "\n".join(lines)
            return OCRResult(
                raw_text=raw_text,
                engine="aws_textract",
                lines=lines,
                success=True
            )
        except Exception as err:
            return OCRResult(
                raw_text="",
                engine="aws_textract",
                success=False,
                error_message=f"AWS Textract error: {str(err)}"
            )
