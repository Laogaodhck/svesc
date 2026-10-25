"""
应用图标生成脚本（一次性工具，可重复运行）。

输入：浩玥工作室 logo（JPG，无 alpha 通道，蓝色渐变圆角方 + 月亮/星环）。
输出：
 - build/icon.ico  —— 多尺寸（16/24/32/48/64/128/256），electron-builder 打包
                     （NSIS 安装器 / portable exe / 任务栏 / 资源管理器）
 - build/icon.png  —— 512px 圆角 alpha 版，BrowserWindow 运行时窗口图标
 - src/renderer/assets/logo.png —— 256px，渲染层 TopBar 品牌区 logo

圆角说明：JPG 无透明通道，四角为白底；按原图圆角占比（约 12.4%）补
alpha 蒙版，避免任务栏/安装器里出现白角。

用法：python scripts/make-icons.py <输入图片路径>
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SIZES = [16, 24, 32, 48, 64, 128, 256]
BIG = 512
# 原图 776px 宽、圆角约 96px → 占比 0.124，四舍五入到整数像素
CORNER_RATIO = 0.124


def rounded(img: Image.Image, size: int) -> Image.Image:
    """缩放到 size 后按 CORNER_RATIO 圆角补 alpha（抗锯齿：4x 超采样蒙版）。"""
    im = img.resize((size, size), Image.LANCZOS).convert("RGBA")
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size * 4 - 1, size * 4 - 1), radius=int(size * CORNER_RATIO * 4), fill=255
    )
    im.putalpha(mask.resize((size, size), Image.LANCZOS))
    return im


def main() -> None:
    src = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "build" / "logo-src.jpg")
    if not src.exists():
        print(f"[make-icons] 输入图片不存在：{src}")
        sys.exit(1)

    base = Image.open(src).convert("RGB")
    # 取中心正方形（原图已接近正方形，保险起见再裁一次）
    side = min(base.size)
    left = (base.width - side) // 2
    top = (base.height - side) // 2
    base = base.crop((left, top, left + side, top + side))

    big = rounded(base, BIG)
    (ROOT / "build").mkdir(exist_ok=True)
    big.save(ROOT / "build" / "icon.png")
    big.resize((256, 256), Image.LANCZOS).save(ROOT / "src" / "renderer" / "assets" / "logo.png")

    # 托盘小图标：Windows 托盘槽位是 16/32px，512 直缩会糊；给一张原生 32px
    (ROOT / "build" / "tray-icon.png").unlink(missing_ok=True)
    rounded(base, 32).save(ROOT / "build" / "tray-icon.png")

    # 任务栏告警角标：16px 红点（setOverlayIcon 用），数量说明由代码拼进 description
    from PIL import Image as _Img
    badge = _Img.new("RGBA", (16, 16), (0, 0, 0, 0))
    _d = ImageDraw.Draw(badge)
    _d.ellipse((2, 2, 14, 14), fill=(229, 57, 53, 255), outline=(255, 255, 255, 230), width=1)
    badge.save(ROOT / "build" / "badge.png")

    (ROOT / "build" / "icon.ico").unlink(missing_ok=True)
    big.save(
        ROOT / "build" / "icon.ico",
        format="ICO",
        sizes=[(s, s) for s in SIZES],
        append_images=[big.resize((s, s), Image.LANCZOS) for s in SIZES],
    )
    print("[make-icons] 生成完成：build/icon.ico / build/icon.png / src/renderer/assets/logo.png")


if __name__ == "__main__":
    main()
