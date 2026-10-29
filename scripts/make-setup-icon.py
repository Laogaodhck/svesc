"""
NSIS 安装器图标生成脚本（一次性工具，可重复运行）。

输入：安装器专用图标源图（PNG，自带 alpha 透明通道）。
输出：
 - build/setup-icon.png —— 居中正方形裁切后的 RGBA 源（入库，保证可复现）
 - build/setup-icon.ico —— 多尺寸（16/24/32/48/64/128/256），
                           仅用作 electron-builder nsis.installerIcon
                           （Setup exe 图标）；应用 exe/托盘/角标等其它
                           图标不受影响（仍走 build/icon.* 一套）。

与 make-icons.py 的区别：源图自带 alpha（无需 JPG 白底补圆角蒙版），
直接 LANCZOS 缩放；ICO 保存时 base 必须是最大分辨率帧（PIL 以 base
尺寸过滤 sizes，小图当 base 会把大档位静默丢掉）。

用法：python scripts/make-setup-icon.py <输入图片路径>
"""
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SIZES = [16, 24, 32, 48, 64, 128, 256]
DEFAULT_SRC = Path(r"E:\GitHub\Setup logo\src-setup-icon.png")


def main() -> None:
    src_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    if not src_path.exists():
        print(f"[make-setup-icon] 输入图片不存在：{src_path}")
        sys.exit(1)

    src = Image.open(src_path).convert("RGBA")
    # 居中正方形裁切（源图已接近正方形，保险起见再裁一次）
    side = min(src.size)
    left = (src.width - side) // 2
    top = (src.height - side) // 2
    src = src.crop((left, top, left + side, top + side))

    out = ROOT / "build"
    out.mkdir(exist_ok=True)
    src.save(out / "setup-icon.png")

    frames = [src.resize((s, s), Image.LANCZOS) for s in SIZES]
    (out / "setup-icon.ico").unlink(missing_ok=True)
    # base 用原分辨率帧：PIL 的 ICO 保存按 base 尺寸过滤目标档位
    src.save(out / "setup-icon.ico", format="ICO", sizes=[(s, s) for s in SIZES], append_images=frames)
    print(f"[make-setup-icon] 生成完成：build/setup-icon.ico（{len(SIZES)} 档）+ build/setup-icon.png")


if __name__ == "__main__":
    main()
