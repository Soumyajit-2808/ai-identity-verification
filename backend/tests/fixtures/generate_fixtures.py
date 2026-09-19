"""
Generate Synthetic Test Fixtures
Creates synthetic, anonymized ID documents and selfies for automated integration testing.
Never uses real PII or biometric files.
"""

import os
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

FIXTURES_DIR = os.path.dirname(os.path.abspath(__file__))
os.makedirs(FIXTURES_DIR, exist_ok=True)


def create_synthetic_id(
    filename: str,
    name: str,
    dob: str,
    id_num: str,
    institution: str = "NATIONAL INSTITUTE OF TECHNOLOGY",
    id_type_heading: str = "STUDENT IDENTITY CARD"
):
    # Create 800x500 white card with a blue top header
    img = np.full((500, 800, 3), 255, dtype=np.uint8)

    # Top header bar (Navy Blue)
    cv2.rectangle(img, (0, 0), (800, 70), (120, 40, 20), -1)

    # Header text
    cv2.putText(img, institution, (50, 45), cv2.FONT_HERSHEY_DUPLEX, 0.8, (255, 255, 255), 2)
    cv2.putText(img, id_type_heading, (50, 110), cv2.FONT_HERSHEY_DUPLEX, 0.7, (50, 50, 50), 2)

    # Synthetic Photo Box (Grey Box with drawn face circle)
    cv2.rectangle(img, (50, 140), (220, 360), (200, 200, 200), -1)
    cv2.rectangle(img, (50, 140), (220, 360), (150, 150, 150), 2)
    # Head and shoulders
    cv2.circle(img, (135, 220), 45, (120, 120, 120), -1)
    cv2.ellipse(img, (135, 340), (70, 50), 0, 180, 360, (90, 90, 90), -1)

    # Text fields
    font = cv2.FONT_HERSHEY_SIMPLEX
    cv2.putText(img, f"NAME: {name}", (260, 180), font, 0.75, (20, 20, 20), 2)
    cv2.putText(img, f"DOB: {dob}", (260, 230), font, 0.75, (20, 20, 20), 2)
    cv2.putText(img, f"ID NO: {id_num}", (260, 280), font, 0.75, (20, 20, 20), 2)
    cv2.putText(img, "DEPARTMENT: COMPUTER SCIENCE", (260, 330), font, 0.65, (70, 70, 70), 2)
    cv2.putText(img, "VALID TILL: 2028", (260, 380), font, 0.65, (70, 70, 70), 2)

    # Bottom border
    cv2.rectangle(img, (0, 480), (800, 500), (120, 40, 20), -1)

    target_path = os.path.join(FIXTURES_DIR, filename)
    cv2.imwrite(target_path, img)
    print(f"[Fixture Created] {target_path}")


def create_synthetic_selfie(filename: str):
    # Create 400x500 selfie-like image
    img = np.full((500, 400, 3), 240, dtype=np.uint8)
    # Head and shoulders
    cv2.circle(img, (200, 200), 75, (140, 140, 140), -1)
    cv2.ellipse(img, (200, 420), (120, 100), 0, 180, 360, (100, 100, 100), -1)
    target_path = os.path.join(FIXTURES_DIR, filename)
    cv2.imwrite(target_path, img)
    print(f"[Fixture Created] {target_path}")


def create_blurry_fixture(filename: str):
    # Tiny 200x120 heavily blurred image
    img = np.full((120, 200, 3), 150, dtype=np.uint8)
    blurred = cv2.GaussianBlur(img, (25, 25), 0)
    target_path = os.path.join(FIXTURES_DIR, filename)
    cv2.imwrite(target_path, blurred)
    print(f"[Fixture Created] {target_path}")


if __name__ == "__main__":
    create_synthetic_id("valid_id.png", "Rahul Sharma", "15/08/2004", "STU1234567")
    create_synthetic_id("minor_id.png", "Aarav Gupta", "15/08/2012", "STU7654321")
    create_synthetic_id("different_name_id.png", "Sunil Verma", "10/02/2002", "STU9988776")
    create_synthetic_selfie("selfie.png")
    create_blurry_fixture("blurry_id.png")
