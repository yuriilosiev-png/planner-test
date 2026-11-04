#!/usr/bin/env python3
"""Формы рта для помощников (этап 1 мастер-плана): картинка от GPT -> кадр поверх оригинала.

GPT перерисовывает всю картинку: чуть сдвигает фигуру, меняет размер, фон. Поэтому
из ответа GPT берём только область рта, выравниваем её по оригиналу и вклеиваем
с мягким краем. Всё остальное (поза, одежда, контур, прозрачность) остаётся от
оригинала, кадры не «плывут» при смене.

    python3 -I tools/mouth_frames.py coach/nadia-hello.webp gpt/nadia-m1.png --out coach/nadia-hello-m1.webp
    python3 -I tools/mouth_frames.py BASE GEN --out OUT [--box x,y,w,h] [--preview prev.png]

--box  — область рта в пикселях оригинала; без неё ищется сама по разнице в зоне лица.
Нужны opencv-python, numpy, Pillow.
"""
import argparse
import sys

import cv2
import numpy as np
from PIL import Image


def load_rgba(path):
    return np.array(Image.open(path).convert('RGBA'))


def gray_on(img, bg=(128, 128, 128)):
    """RGBA -> серое на ровном фоне (одинаковом для оригинала и ответа GPT)."""
    a = img[..., 3:4].astype(np.float32) / 255
    rgb = img[..., :3].astype(np.float32) * a + np.array(bg, np.float32) * (1 - a)
    return cv2.cvtColor(rgb.astype(np.uint8), cv2.COLOR_RGB2GRAY)


def cut_background(gen, ref_alpha_ratio):
    """У GPT фон часто сплошной: убираем цвет углов, если прозрачности нет."""
    if gen[..., 3].min() < 250:
        return gen
    corners = np.concatenate([gen[:8, :8, :3].reshape(-1, 3), gen[:8, -8:, :3].reshape(-1, 3),
                              gen[-8:, :8, :3].reshape(-1, 3), gen[-8:, -8:, :3].reshape(-1, 3)])
    bg = np.median(corners, axis=0)
    dist = np.linalg.norm(gen[..., :3].astype(np.float32) - bg, axis=2)
    out = gen.copy()
    out[..., 3] = np.where(dist < 28, 0, 255).astype(np.uint8)
    return out


def align(base, gen):
    """Подобие (сдвиг + масштаб + поворот) от ответа GPT к оригиналу по ключевым точкам."""
    g1, g2 = gray_on(base), gray_on(gen)
    sift = cv2.SIFT_create(4000)
    k1, d1 = sift.detectAndCompute(g1, None)
    k2, d2 = sift.detectAndCompute(g2, None)
    if d1 is None or d2 is None:
        sys.exit('не нашёл общих точек — пришли картинку в той же позе')
    m = cv2.BFMatcher().knnMatch(d2, d1, k=2)
    good = [a for a, b in m if a.distance < 0.75 * b.distance]
    if len(good) < 12:
        sys.exit(f'мало совпадений ({len(good)}) — картинка слишком отличается от оригинала')
    src = np.float32([k2[a.queryIdx].pt for a in good])
    dst = np.float32([k1[a.trainIdx].pt for a in good])
    M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=3)
    if M is None:
        sys.exit('не удалось выровнять')
    h, w = base.shape[:2]
    warped = cv2.warpAffine(gen, M, (w, h), flags=cv2.INTER_CUBIC, borderValue=(0, 0, 0, 0))
    scale = float(np.hypot(M[0, 0], M[0, 1]))
    return warped, int(inl.sum()), len(good), scale


def find_box(base, warped):
    """Самая сильная разница в верхней четверти (лицо) — это рот."""
    h, w = base.shape[:2]
    top = int(h * 0.28)
    a = cv2.GaussianBlur(gray_on(base[:top]), (5, 5), 0).astype(np.int16)
    b = cv2.GaussianBlur(gray_on(warped[:top]), (5, 5), 0).astype(np.int16)
    d = (np.abs(a - b) > 40).astype(np.uint8) * 255
    d = cv2.morphologyEx(d, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    d = cv2.dilate(d, np.ones((7, 7), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(d)
    if n < 2:
        sys.exit('разницы с оригиналом не видно — задай --box вручную')
    i = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    x, y, bw, bh = (int(v) for v in stats[i, :4])
    pad = max(6, int(max(bw, bh) * 0.35))
    return max(0, x - pad), max(0, y - pad), min(w, x + bw + pad) - max(0, x - pad), min(top, y + bh + pad) - max(0, y - pad)


def paste(base, warped, box):
    x, y, bw, bh = box
    mask = np.zeros(base.shape[:2], np.float32)
    cv2.ellipse(mask, (x + bw // 2, y + bh // 2), (bw // 2, bh // 2), 0, 0, 360, 1, -1)
    mask = cv2.GaussianBlur(mask, (0, 0), max(2, min(bw, bh) / 8))
    mask *= (warped[..., 3] > 0) & (base[..., 3] > 0)   # силуэт — только от оригинала
    m = mask[..., None]
    out = base.copy().astype(np.float32)
    out[..., :3] = base[..., :3] * (1 - m) + warped[..., :3] * m
    return out.astype(np.uint8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('base')
    ap.add_argument('gen')
    ap.add_argument('--out', required=True)
    ap.add_argument('--box')
    ap.add_argument('--preview')
    o = ap.parse_args()
    base = load_rgba(o.base)
    gen = cut_background(load_rgba(o.gen), None)
    warped, inl, good, scale = align(base, gen)
    box = tuple(int(v) for v in o.box.split(',')) if o.box else find_box(base, warped)
    out = paste(base, warped, box)
    Image.fromarray(out).save(o.out, quality=90, method=6)
    print(f'ok {o.out}: совпадений {inl}/{good}, масштаб {scale:.3f}, рот {box}')
    if o.preview:
        x, y, bw, bh = box
        cx, cy, r = x + bw // 2, y + bh // 2, max(bw, bh) * 2
        crop = lambda im: Image.fromarray(im).crop((cx - r, cy - r, cx + r, cy + r)).resize((240, 240))
        sheet = Image.new('RGBA', (480, 240), (40, 40, 48, 255))
        sheet.alpha_composite(crop(base), (0, 0))
        sheet.alpha_composite(crop(out), (240, 0))
        sheet.save(o.preview)


if __name__ == '__main__':
    main()
