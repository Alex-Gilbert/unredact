from dataclasses import dataclass

import pytesseract 
pytesseract.pytesseract.tesseract_cmd = r"C:\Program Files\Tesseract-OCR\tesseract.exe"

from PIL import Image


@dataclass
class OcrChar:
    """A single OCR'd character with its bounding box."""
    text: str
    x: int
    y: int
    w: int
    h: int
    conf: float  # 0-100 confidence


@dataclass
class OcrLine:
    """A line of OCR'd text."""
    chars: list[OcrChar]
    x: int
    y: int
    w: int
    h: int

    @property
    def text(self) -> str:
        return "".join(c.text for c in self.chars)


def ocr_page(image: Image.Image) -> list[OcrLine]:
    """Run Tesseract OCR on an image and return character-level results.

    Uses tsv output to get bounding boxes at every level.
    We use word-level boxes and estimate character positions from them
    (Tesseract's character-level output is unreliable).
    """
    data = pytesseract.image_to_data(
        image, output_type=pytesseract.Output.DICT, config="--psm 6"
    )

    # Group words into lines, then estimate character positions
    lines: dict[tuple[int, int, int, int], list[dict]] = {}
    n = len(data["text"])

    for i in range(n):
        text = data["text"][i].strip()
        if not text:
            continue
        conf = float(data["conf"][i])
        if conf < 0:
            continue

        line_key = (
            data["block_num"][i],
            data["par_num"][i],
            data["line_num"][i],
            0,
        )
        word_info = {
            "text": text,
            "x": data["left"][i],
            "y": data["top"][i],
            "w": data["width"][i],
            "h": data["height"][i],
            "conf": conf,
        }
        lines.setdefault(line_key, []).append(word_info)

    result: list[OcrLine] = []
    for _key, words in sorted(lines.items()):
        chars: list[OcrChar] = []
        for wi, word in enumerate(words):
            # Estimate per-character positions by dividing word box evenly
            word_text = word["text"]
            if not word_text:
                continue
            char_w = word["w"] / len(word_text)
            for ci, ch in enumerate(word_text):
                chars.append(OcrChar(
                    text=ch,
                    x=int(word["x"] + ci * char_w),
                    y=word["y"],
                    w=max(1, int(char_w)),
                    h=word["h"],
                    conf=word["conf"],
                ))
            # Add space character between words (except after last word)
            if wi < len(words) - 1:
                next_word = words[wi + 1]
                space_x = word["x"] + word["w"]
                space_w = next_word["x"] - space_x
                if space_w > 0:
                    chars.append(OcrChar(
                        text=" ",
                        x=space_x,
                        y=word["y"],
                        w=space_w,
                        h=word["h"],
                        conf=word["conf"],
                    ))

        if chars:
            line_x = chars[0].x
            line_y = min(c.y for c in chars)
            line_w = (chars[-1].x + chars[-1].w) - line_x
            line_h = max(c.y + c.h for c in chars) - line_y
            result.append(OcrLine(
                chars=chars, x=line_x, y=line_y, w=line_w, h=line_h
            ))

    return result
