# darken-bottle-shots.ps1 — take catalogue product shots off their white
# background and set them on Alcove's dark ground.
#
# Why bake it in rather than ship transparent PNGs: Sanctum is offline-first, and
# photographic PNGs with an alpha channel run to several megabytes across the set
# against ~25KB each as JPEG. The app has no light theme (css/styles.css defines
# one palette, near-black), so a baked dark ground is never wrong.
#
# Re-runnable, but NOT idempotent — it rewrites in place and a second pass would
# key against a background that is no longer white. Re-run it on pristine
# downloads, which are all re-fetchable from each entry's imageUrl.
#
#   powershell -ExecutionPolicy Bypass -File scripts\darken-bottle-shots.ps1
#
# Method:
#   1. Flood fill from the border across near-white, neutral pixels. Border-
#      connected only, so a white LABEL inside the bottle survives — a plain
#      brightness threshold would punch holes through every label in the set.
#   2. Feather that binary mask by one pixel so edges are not stair-stepped.
#   3. Un-mix the anti-aliased edge: those pixels are part bottle, part white
#      paper. Composited as-is over black they leave a bright halo, so the white
#      contribution is divided back out first.
#   4. Composite over a radial ground matching the tile — dark at the rim, a
#      touch lighter behind the bottle, which reads as studio lighting.
#
# The pixel work is C# rather than PowerShell: these are 375x500 images and a
# per-pixel PowerShell loop over the set runs into minutes.

param(
  [string]$Dir = (Join-Path $PSScriptRoot "..\img\perfumes"),
  [int]$WhiteSeed = 242,   # a border pixel this bright (and neutral) starts a fill
  [int]$WhiteGrow = 232,   # the fill spreads through anything this bright
  [int]$Neutral   = 14,    # max channel spread still counted as grey, not colour
  [int]$Close     = 6,     # seal intrusions this thin; see CLEAR GLASS below
  [bool]$SpanFill = $true, # fill each row between the silhouette edges
  [string]$Only   = ''     # process one filename, for per-bottle overrides
)

# CLEAR GLASS. A crystal bottle lets the white paper through, so the fill walks
# in via the glass and leaves hard black holes inside the bottle (Lattafa
# Khamrah is the worst of the set). Raising the threshold cannot help — the
# paper really is 255 in there. So the mask gets a morphological CLOSE: grow the
# foreground by $Close pixels, then shrink it back. Thin channels and small
# interior holes are sealed; the outer silhouette returns to where it was.
#
# SOFT SHADOWS. A source with a drop shadow (em5-aghori, cropped from a
# marketing banner) has a grey gradient round the bottle. Whatever falls below
# $WhiteGrow survives as a pale band on the dark ground. Lower $WhiteGrow for
# that file specifically with -Only and -WhiteGrow; there is no single threshold
# that suits both a shadowed source and a silver cap.

Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class BottleShot {
  // Alcove's ground: --bg #0A0A0B at the rim, just past --surface-2 #1B1B1E
  // behind the bottle. Keep in step with .al-shot in css/styles.css.
  const double EdgeR = 10, EdgeG = 10, EdgeB = 11;
  const double CtrR  = 30, CtrG  = 30, CtrB  = 34;

  public static void Convert(string path, int whiteSeed, int whiteGrow, int neutral, int close, bool spanFill, int quality) {
    byte[] src; int w, h, stride;
    using (Bitmap bmp = new Bitmap(path)) {
      w = bmp.Width; h = bmp.Height;
      Rectangle rect = new Rectangle(0, 0, w, h);
      BitmapData d = bmp.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
      stride = d.Stride;
      src = new byte[stride * h];
      Marshal.Copy(d.Scan0, src, 0, src.Length);
      bmp.UnlockBits(d);
    }

    int n = w * h;
    bool[] bg = new bool[n];
    Stack<int> stack = new Stack<int>();

    for (int x = 0; x < w; x++) { Seed(src, stride, w, bg, stack, x, 0, whiteSeed, neutral);
                                  Seed(src, stride, w, bg, stack, x, h - 1, whiteSeed, neutral); }
    for (int y = 0; y < h; y++) { Seed(src, stride, w, bg, stack, 0, y, whiteSeed, neutral);
                                  Seed(src, stride, w, bg, stack, w - 1, y, whiteSeed, neutral); }

    int[] dx = { 1, -1, 0, 0 }, dy = { 0, 0, 1, -1 };
    while (stack.Count > 0) {
      int i = stack.Pop(); int x = i % w, y = i / w;
      for (int k = 0; k < 4; k++) {
        int nx = x + dx[k], ny = y + dy[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        int j = ny * w + nx;
        if (bg[j] || !Light(src, stride, nx, ny, whiteGrow, neutral)) continue;
        bg[j] = true; stack.Push(j);
      }
    }

    // Close the foreground: dilate then erode by the same radius. Seals the thin
    // channels the fill walked through into clear glass, without moving the
    // silhouette. Border pixels are pinned to background so the frame cannot
    // grow inward and reintroduce a white rim.
    if (close > 0) {
      bool[] fg = new bool[n];
      for (int i = 0; i < n; i++) fg[i] = !bg[i];
      fg = Morph(fg, w, h, close, true);
      fg = Morph(fg, w, h, close, false);
      for (int i = 0; i < n; i++) bg[i] = !fg[i];
      for (int x = 0; x < w; x++) { bg[x] = !Light(src, stride, x, 0, whiteGrow, neutral) ? bg[x] : true;
                                    bg[(h - 1) * w + x] = !Light(src, stride, x, h - 1, whiteGrow, neutral) ? bg[(h - 1) * w + x] : true; }
    }

    // SPAN FILL. Closing seals thin channels but not the broad sheets of clear
    // crystal in a bottle like Khamrah's cap, which really is the same 255 as
    // the paper behind it — no threshold separates those. A perfume bottle is
    // horizontally convex in every shot in this set, so take the largest
    // foreground blob and, row by row, declare everything between its leftmost
    // and rightmost pixel to be bottle. Interior holes vanish and the silhouette
    // is untouched. Restricting to the largest blob first means a stray speck of
    // keying noise cannot stretch a row across the whole frame.
    if (spanFill) {
      bool[] fg = new bool[n];
      for (int i = 0; i < n; i++) fg[i] = !bg[i];
      fg = LargestBlob(fg, w, h);
      for (int y = 0; y < h; y++) {
        int lo = -1, hi = -1;
        for (int x = 0; x < w; x++) if (fg[y * w + x]) { if (lo < 0) lo = x; hi = x; }
        if (lo < 0) continue;
        for (int x = lo; x <= hi; x++) bg[y * w + x] = false;
      }
    }

    // feather the binary mask by one pixel
    double[] soft = new double[n];
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      double sum = 0; int cnt = 0;
      for (int b = -1; b <= 1; b++) for (int a = -1; a <= 1; a++) {
        int nx = x + a, ny = y + b;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        sum += bg[ny * w + nx] ? 0.0 : 1.0; cnt++;
      }
      soft[y * w + x] = sum / cnt;
    }

    byte[] outb = new byte[stride * h];
    double cx = w / 2.0, cy = h * 0.46;
    double maxD = Math.Sqrt(cx * cx + cy * cy);

    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
      int i = y * w + x, o = x * 4 + y * stride;
      double a = soft[i];
      double sb = src[o], sg = src[o + 1], sr = src[o + 2];

      double ddx = x - cx, ddy = y - cy;
      double t = Math.Min(1.0, Math.Sqrt(ddx * ddx + ddy * ddy) / maxD);
      t *= t;                                       // hold the glow near the centre
      double gr = CtrR + (EdgeR - CtrR) * t;
      double gg = CtrG + (EdgeG - CtrG) * t;
      double gb = CtrB + (EdgeB - CtrB) * t;

      double r, g, b2;
      if (a <= 0.004) { r = gr; g = gg; b2 = gb; }
      else {
        if (a < 0.996) {   // observed = a*object + (1-a)*white -> recover object
          sr = Clamp((sr - (1 - a) * 255) / a);
          sg = Clamp((sg - (1 - a) * 255) / a);
          sb = Clamp((sb - (1 - a) * 255) / a);
        }
        r = sr * a + gr * (1 - a);
        g = sg * a + gg * (1 - a);
        b2 = sb * a + gb * (1 - a);
      }
      outb[o]     = (byte)Math.Round(Clamp(b2));
      outb[o + 1] = (byte)Math.Round(Clamp(g));
      outb[o + 2] = (byte)Math.Round(Clamp(r));
      outb[o + 3] = 255;
    }

    string tmp = path + ".tmp";
    using (Bitmap outBmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
      Rectangle rect = new Rectangle(0, 0, w, h);
      BitmapData od = outBmp.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
      Marshal.Copy(outb, 0, od.Scan0, outb.Length);
      outBmp.UnlockBits(od);
      ImageCodecInfo enc = null;
      foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") enc = c;
      EncoderParameters ep = new EncoderParameters(1);
      ep.Param[0] = new EncoderParameter(Encoder.Quality, (long)quality);
      outBmp.Save(tmp, enc, ep);
    }
    System.IO.File.Delete(path);
    System.IO.File.Move(tmp, path);
  }

  // Keep only the biggest connected true-region; drop keying speckle.
  static bool[] LargestBlob(bool[] m, int w, int h) {
    int n = w * h;
    int[] label = new int[n];
    int best = 0, bestSize = 0, cur = 0;
    int[] dx = { 1, -1, 0, 0 }, dy = { 0, 0, 1, -1 };
    Stack<int> st = new Stack<int>();
    for (int s = 0; s < n; s++) {
      if (!m[s] || label[s] != 0) continue;
      cur++; int size = 0;
      label[s] = cur; st.Push(s);
      while (st.Count > 0) {
        int i = st.Pop(); size++;
        int x = i % w, y = i / w;
        for (int k = 0; k < 4; k++) {
          int nx = x + dx[k], ny = y + dy[k];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          int j = ny * w + nx;
          if (!m[j] || label[j] != 0) continue;
          label[j] = cur; st.Push(j);
        }
      }
      if (size > bestSize) { bestSize = size; best = cur; }
    }
    bool[] outm = new bool[n];
    for (int i = 0; i < n; i++) outm[i] = label[i] == best && m[i];
    return outm;
  }

  // One morphological pass, repeated `r` times. dilate=true grows the set.
  static bool[] Morph(bool[] m, int w, int h, int r, bool dilate) {
    int[] dx = { 1, -1, 0, 0 }, dy = { 0, 0, 1, -1 };
    bool[] cur = m;
    for (int pass = 0; pass < r; pass++) {
      bool[] next = new bool[cur.Length];
      for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
        int i = y * w + x;
        bool v = cur[i];
        for (int k = 0; k < 4 && (dilate ? !v : v); k++) {
          int nx = x + dx[k], ny = y + dy[k];
          bool nb = (nx < 0 || ny < 0 || nx >= w || ny >= h) ? !dilate : cur[ny * w + nx];
          if (dilate) { if (nb) v = true; } else { if (!nb) v = false; }
        }
        next[i] = v;
      }
      cur = next;
    }
    return cur;
  }

  static double Clamp(double v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

  static bool Light(byte[] s, int stride, int x, int y, int thr, int neutral) {
    int o = x * 4 + y * stride;
    int b = s[o], g = s[o + 1], r = s[o + 2];
    if (r < thr || g < thr || b < thr) return false;
    int mx = Math.Max(r, Math.Max(g, b)), mn = Math.Min(r, Math.Min(g, b));
    return (mx - mn) <= neutral;
  }

  static void Seed(byte[] s, int stride, int w, bool[] bg, Stack<int> st,
                   int x, int y, int thr, int neutral) {
    int i = y * w + x;
    if (bg[i] || !Light(s, stride, x, y, thr, neutral)) return;
    bg[i] = true; st.Push(i);
  }
}
'@

Get-ChildItem (Join-Path $Dir "*.jpg") | Where-Object { -not $Only -or $_.Name -eq $Only } | ForEach-Object {
  [BottleShot]::Convert($_.FullName, $WhiteSeed, $WhiteGrow, $Neutral, $Close, $SpanFill, 90)
  "{0,-40} {1,7:N0} bytes" -f $_.Name, (Get-Item $_.FullName).Length
}
