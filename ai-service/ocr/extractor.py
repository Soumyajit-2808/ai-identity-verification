import re
from PIL import Image, ImageEnhance, ImageFilter
import pytesseract

pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"


def preprocess_image(image: Image.Image) -> Image.Image:
    """
    Basic preprocessing to improve OCR quality.
    """
    image = image.convert("L")

    # Increase contrast
    image = ImageEnhance.Contrast(image).enhance(2.0)

    # Sharpen text
    image = image.filter(ImageFilter.SHARPEN)

    # Upscale smaller documents
    width, height = image.size

    if width < 1500:
        scale = 1500 / width
        image = image.resize(
            (int(width * scale), int(height * scale))
        )

    return image


def extract_text(image: Image.Image) -> str:
    """
    Run Tesseract OCR on the supplied image.
    """
    processed = preprocess_image(image)

    text = pytesseract.image_to_string(
        processed,
        config="--psm 6"
    )

    return text.strip()


def extract_dob(text: str):
    """
    Attempt to extract common date-of-birth formats.
    """
    patterns = [
        r"\b\d{2}[/-]\d{2}[/-]\d{4}\b",
        r"\b\d{2}[/-]\d{2}[/-]\d{2}\b",
        r"\b\d{4}[/-]\d{2}[/-]\d{2}\b",
    ]

    for pattern in patterns:
        match = re.search(pattern, text)

        if match:
            return match.group(0)

    return None


def extract_id_number(text: str):
    """
    Attempt to identify a common ID-number-like alphanumeric string.
    This is intentionally conservative and should NOT be treated
    as authoritative identification.
    """
    patterns = [
        r"\b[A-Z]{3}\d{7}\b",
        r"\b[A-Z]{2}\d{8,12}\b",
        r"\b\d{4}\s\d{4}\s\d{4}\b",
    ]

    for pattern in patterns:
        match = re.search(pattern, text.upper())

        if match:
            return match.group(0)

    return None


def extract_name(text: str):
    """
    Extract a person's name from common ID-document layouts.
    Handles OCR noise before the NAME label.
    """

    lines = [
        re.sub(r"\s+", " ", line).strip()
        for line in text.splitlines()
        if line.strip()
    ]

    for index, line in enumerate(lines):

        # Find NAME even if OCR added characters before it
        match = re.search(
            r"\b(?:FULL\s+)?NAME\s*[:\-]?\s*(.*)$",
            line,
            re.IGNORECASE
        )

        if match:
            value = match.group(1).strip(" :-_")

            if value:
                return value

            # Handles:
            # Name
            # Rahul Sharma
            if index + 1 < len(lines):
                next_line = lines[index + 1].strip(" :-_")

                if not re.match(
                    r"^(?:DOB|DATE OF BIRTH|STUDENT ID|ID|DEPARTMENT|VALID)",
                    next_line,
                    re.IGNORECASE
                ):
                    return next_line

    return None


def extract_identity_fields(text: str):
    """
    Convert raw OCR text into a basic structured representation.
    """
    return {
        "name": extract_name(text),
        "date_of_birth": extract_dob(text),
        "id_number": extract_id_number(text),
    }


def process_document(image: Image.Image):
    """
    Complete OCR pipeline.
    """
    raw_text = extract_text(image)

    fields = extract_identity_fields(raw_text)

    return {
        "raw_text": raw_text,
        "fields": fields,
    }