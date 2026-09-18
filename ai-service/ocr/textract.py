import os
import boto3


def textract_available():
    return bool(
        os.getenv("AWS_ACCESS_KEY_ID")
        and os.getenv("AWS_SECRET_ACCESS_KEY")
        and os.getenv("AWS_REGION")
    )


def extract_with_textract(contents):
    if not textract_available():
        return None

    client = boto3.client(
        "textract",
        region_name=os.getenv("AWS_REGION")
    )

    response = client.detect_document_text(
        Document={
            "Bytes": contents
        }
    )

    lines = []

    for block in response.get("Blocks", []):
        if block.get("BlockType") == "LINE":
            text = block.get("Text")

            if text:
                lines.append(text)

    return "\n".join(lines)