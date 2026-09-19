"""
OCR Provider Base Interface and Models
"""

from abc import ABC, abstractmethod
from typing import List, Optional
from pydantic import BaseModel


class OCRLine(BaseModel):
    text: str
    confidence: Optional[float] = None


class OCRResult(BaseModel):
    raw_text: str
    engine: str
    lines: List[str] = []
    success: bool = True
    error_message: Optional[str] = None


class BaseOCRProvider(ABC):
    @abstractmethod
    def is_available(self) -> bool:
        """Check if this OCR provider is configured and operational."""
        pass

    @abstractmethod
    def extract_text(self, image_bytes: bytes) -> OCRResult:
        """Execute OCR extraction on the provided image binary."""
        pass
