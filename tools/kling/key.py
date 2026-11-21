"""Ролик Kling (mp4, 724x1284, Keyframes) -> PNG-кадры 550x920 с прозрачным фоном.

python3 key.py <in.mp4> <out_dir> --key green|magenta [--xf S,SX0,SY0]

--xf  фиксированное преобразование персонажа (одно на все его ролики):
      nadia  0.722,-26.89,-2.62   (зелёный фон)
      genie  0.7206,-11.14,-4.65  (пурпурный фон)
      Без --xf считается по первому кадру и печатается — запиши его для персонажа.
Дальше:
ffmpeg -framerate 24 -i out_dir/%04d.png -c:v libvpx-vp9 -pix_fmt yuva420p -crf 40 -b:v 0 -an coach/<p>-v-<clip>.webm
Первый кадр idle -> coach/<p>-v-base.webp
"""
import subprocess, json, os, shutil, argparse
import numpy as np
from PIL import Image
W, H, TOP, BOT = 550, 920, 12, 912

def frames(path):
    pr = subprocess.run(['ffprobe','-v','error','-select_streams','v','-show_entries','stream=width,height','-of','json',path], capture_output=True, text=True)
    s = json.loads(pr.stdout)['streams'][0]; w, h = s['width'], s['height']
    raw = subprocess.run(['ffmpeg','-v','error','-i',path,'-f','rawvideo','-pix_fmt','rgb24','-'], capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)

def key(f, mode):
    f = f.astype(np.int16); r, g, b = f[...,0], f[...,1], f[...,2]
    if mode == 'green':
        gn = g - np.maximum(r, b)
        a = np.clip((30 - gn) / 18, 0, 1)
        g = np.where(gn > 0, np.maximum(r, b), g)
    else:
        mg = np.minimum(r, b) - g
        a = np.clip((190 - mg) / 40, 0, 1)
        sp = np.clip(mg - 60, 0, None) * (1 - a) * 0.6
        r = r - sp; b = b - sp
    rgb = np.stack([r, g, b], -1).clip(0, 255).astype(np.uint8)
    return np.dstack([rgb, (a * 255).astype(np.uint8)])

ap = argparse.ArgumentParser()
ap.add_argument('src'); ap.add_argument('out')
ap.add_argument('--key', choices=['green','magenta'], required=True)
ap.add_argument('--xf')
o = ap.parse_args()
fr = frames(o.src)
if o.xf:
    s, sx0, sy0 = map(float, o.xf.split(','))
else:
    al = key(fr[0], o.key)[...,3] > 60; ys, xs = np.where(al)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    s = min((BOT-TOP)/(y1-y0), (W-30)/(x1-x0)); cx = (x0+x1)/2
    sx0 = cx - (W/2)/s; sy0 = y0 - (TOP + (BOT-TOP-(y1-y0)*s))/s
    print('--xf %.4f,%.2f,%.2f' % (s, sx0, sy0))
shutil.rmtree(o.out, ignore_errors=True); os.makedirs(o.out)
for n in range(len(fr)):
    Image.fromarray(key(fr[n], o.key), 'RGBA').transform((W, H), Image.AFFINE, (1/s, 0, sx0, 0, 1/s, sy0), resample=Image.BICUBIC).save(f'{o.out}/{n:04d}.png')
d = np.abs(np.array(Image.open(f'{o.out}/0000.png'), float) - np.array(Image.open(f'{o.out}/{len(fr)-1:04d}.png'), float)).mean()
print(len(fr), 'frames; first-last diff', round(d, 2), '(<3 = петля без скачка)')
