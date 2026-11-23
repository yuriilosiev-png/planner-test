"""Vidu mp4 (720x1278, purple bg drifting) -> RGBA PNG frames 550x920 aligned to <p>-v-base.webp.
python3 vidu_key.py in.mp4 base.webp out_dir [--fade N] [--wm x0,y0,x1,y1]"""
import sys, subprocess, json, os, shutil, argparse
import numpy as np
from PIL import Image
W, H = 550, 920
ap = argparse.ArgumentParser(); ap.add_argument('src'); ap.add_argument('base'); ap.add_argument('out')
ap.add_argument('--fade', type=int, default=8); ap.add_argument('--wm', default='600,1228,720,1278')
ap.add_argument('--xf')
o = ap.parse_args()
pr = subprocess.run(['ffprobe','-v','error','-select_streams','v','-show_entries','stream=width,height','-of','json',o.src], capture_output=True, text=True)
s0 = json.loads(pr.stdout)['streams'][0]; w, h = s0['width'], s0['height']
raw = subprocess.run(['ffmpeg','-v','error','-i',o.src,'-f','rawvideo','-pix_fmt','rgb24','-'], capture_output=True).stdout
fr = np.frombuffer(raw, np.uint8).reshape(-1, h, w, 3)
wx0, wy0, wx1, wy1 = map(int, o.wm.split(','))

def key(f):
    f = f.astype(np.float32); r, g, b = f[...,0], f[...,1], f[...,2]
    corners = np.concatenate([f[10:70,10:70].reshape(-1,3), f[10:70,-70:-10].reshape(-1,3)])
    br, bg_, bb = np.median(corners, 0)
    dbg = min(br, bb) - bg_ - abs(br - bb)
    d = np.minimum(r, b) - g - np.abs(r - b)
    a = np.clip((0.75*dbg - d) / (0.2*dbg), 0, 1)
    sp = np.clip(np.minimum(r, b) - g - 40, 0, None) * (1 - a) * 0.6   # despill edges
    r = r - sp; b = b - sp
    a[wy0:wy1, wx0:wx1] = 0
    rgb = np.stack([r, g, b], -1).clip(0, 255).astype(np.uint8)
    return np.dstack([rgb, (a*255).astype(np.uint8)])

base = np.array(Image.open(o.base).convert('RGBA')).astype(np.float32)
def place(rgba, s, sx0, sy0):
    return np.array(Image.fromarray(rgba, 'RGBA').transform((W, H), Image.AFFINE, (1/s, 0, sx0, 0, 1/s, sy0), resample=Image.BICUBIC)).astype(np.float32)

k0 = key(fr[0])
if o.xf:
    s, sx0, sy0 = map(float, o.xf.split(','))
else:
    # bbox init
    def bb(al):
        ys, xs = np.where(al > 128); return ys.min(), ys.max(), xs.min(), xs.max()
    by0, by1, bx0, bx1 = bb(base[...,3]); vy0, vy1, vx0, vx1 = bb(k0[...,3])
    s = (by1-by0)/(vy1-vy0); sx0 = vx0 - bx0/s; sy0 = vy0 - by0/s
    def err(p):
        return np.abs(place(k0, *p)[...,3] - base[...,3]).mean()
    best = (err((s,sx0,sy0)), (s,sx0,sy0))
    for step in [(0.004,2.0),(0.002,1.0),(0.001,0.5),(0.0005,0.25)]:
        improved = True
        while improved:
            improved = False
            cs = best[1]
            for ds in (-step[0],0,step[0]):
                for dx in (-step[1],0,step[1]):
                    for dy in (-step[1],0,step[1]):
                        p = (cs[0]+ds, cs[1]+dx, cs[2]+dy); e = err(p)
                        if e < best[0] - 1e-4: best = (e, p); improved = True
    s, sx0, sy0 = best[1]
    print('--xf %.4f,%.2f,%.2f  alpha err %.2f' % (s, sx0, sy0, best[0]))

shutil.rmtree(o.out, ignore_errors=True); os.makedirs(o.out)
n = len(fr); out = []
for i in range(n):
    out.append(place(key(fr[i]), s, sx0, sy0))
def blend(x, y, t):   # premultiplied blend x->y
    ax, ay = x[...,3:]/255, y[...,3:]/255
    a = ax*(1-t) + ay*t
    c = (x[...,:3]*ax*(1-t) + y[...,:3]*ay*t) / np.maximum(a, 1e-6)
    return np.dstack([c, a*255])
F = o.fade
print('first-base diff before', round(np.abs(out[0]-base).mean(),2), 'last-base', round(np.abs(out[-1]-base).mean(),2))
for i in range(F):                       # start: base -> clip
    out[i] = blend(base, out[i], (i+1)/(F+1)) if i < F else out[i]
for j in range(F):                       # end: clip -> base
    i = n-F+j; out[i] = blend(out[i], base, (j+1)/F)
out[0] = base.copy(); out[-1] = base.copy()
for i, x in enumerate(out):
    Image.fromarray(x.clip(0,255).astype(np.uint8), 'RGBA').save(f'{o.out}/{i:04d}.png')
print(n, 'frames written')
