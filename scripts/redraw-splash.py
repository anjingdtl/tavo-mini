"""
重绘 splash.png 启动图:
- 把 "Tavo小说工作台" 改为两行: "ShineWriter" + "小说工作台"
- 副标题/第三行/装饰金线下移 (因为大标题区扩大)
- 卡片底色用周围色采样后涂回
"""
from PIL import Image, ImageDraw, ImageFont
import numpy as np

SRC = r"F:\ClaudeWorkSpace\projects\TAVO-MINI\src\assets\splash.png"
DST = SRC
DST_ANDROID = r"F:\ClaudeWorkSpace\projects\TAVO-MINI\android\app\src\main\res\drawable-nodpi\splash_screen.png"

CARD_BG_FALLBACK = (84, 92, 100)

# 字体
FONT_EN_BOLD = r"C:\Windows\Fonts\arialbd.ttf"  # 英文粗体
FONT_CN_BOLD = r"C:\Windows\Fonts\Dengb.ttf"    # 中文粗体 (等线)
FONT_CN_LIGHT = r"C:\Windows\Fonts\Dengl.ttf"   # 中文细体

# 颜色
COLOR_TITLE = (217, 204, 170)   # 大标题奶油色
COLOR_SUBTITLE = (217, 204, 170)  # 副标题金黄 (跟原图一致)
COLOR_CAPTION = (200, 200, 200)  # 第三行浅灰白
COLOR_SHADOW = (24, 32, 42)      # 文字阴影
COLOR_LINE = (217, 204, 170)     # 装饰金线

# 字号
SIZE_TITLE = 100
SIZE_SUBTITLE = 80
SIZE_CAPTION = 30
SIZE_CAPTION_CN = 30

# 布局 (y 是文字顶部, PIL draw.text 用 top-y)
Y_TITLE_LINE1 = 660
Y_TITLE_LINE2 = 810
Y_SUBTITLE = 940
Y_CAPTION = 1010
Y_LINE = 1075  # 装饰线

# 涂抹区域 (覆盖所有需要重绘的文字 + 线)
REPAINT_BOX = (130, 590, 950, 1110)

# 副标题/第三行内容
SUBTITLE_TEXT = "移动端小说创作 · 资料 · AI 工作台"
CAPTION_TEXT = "专注写作 / 角色卡 / 世界书 / 灵感笔记"

# 装饰金线参数
LINE_WIDTH = 280
LINE_THICKNESS = 2

SHADOW_OFFSET = 4
TEXT_SHADOW_OFFSET = 3


def sample_card_bg(img, box):
    """从 box 边缘外的区域采样卡片背景色 (中位数)."""
    arr = np.array(img)
    x0, y0, x1, y1 = box
    h, w = arr.shape[:2]
    samples = []
    if y0 - 20 > 0:
        samples.append(arr[max(0, y0 - 20):y0 - 5, x0:x1])
    if y1 + 20 < h:
        samples.append(arr[y1 + 5:y1 + 20, x0:x1])
    if x0 - 20 > 0:
        samples.append(arr[y0:y1, max(0, x0 - 20):x0 - 5])
    if x1 + 20 < w:
        samples.append(arr[y0:y1, x1 + 5:x1 + 20])
    if not samples:
        return CARD_BG_FALLBACK
    all_pixels = np.concatenate([s.reshape(-1, 3) for s in samples], axis=0)
    return tuple(int(c) for c in np.median(all_pixels, axis=0))


def paint_box(img, box, color):
    x0, y0, x1, y1 = box
    draw = ImageDraw.Draw(img)
    draw.rectangle([x0, y0, x1, y1], fill=color)
    return img


def draw_centered_text(img, text, font, baseline_y, fill, shadow=None, offset=0):
    """居中画文字, 可选阴影."""
    draw = ImageDraw.Draw(img)
    bbox = draw.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    img_w = img.size[0]
    text_x = (img_w - text_w) // 2 - bbox[0]
    text_y = baseline_y
    if shadow is not None:
        draw.text((text_x + offset, text_y + offset), text, font=font, fill=shadow)
    draw.text((text_x, text_y), text, font=font, fill=fill)
    return (text_x, text_y, text_x + text_w, baseline_y)


def draw_hline(img, y, width, thickness, color, img_w):
    """画一条水平居中的线."""
    draw = ImageDraw.Draw(img)
    x0 = (img_w - width) // 2
    x1 = x0 + width
    draw.rectangle([x0, y, x1, y + thickness], fill=color)


def main():
    img = Image.open(SRC).convert("RGB")
    print("loaded", img.size, img.mode)

    # 1) 采样卡片背景色
    bg = sample_card_bg(img, REPAINT_BOX)
    print("sampled bg:", bg)

    # 2) 涂背景
    paint_box(img, REPAINT_BOX, bg)

    # 3) 加载字体
    f_title = ImageFont.truetype(FONT_EN_BOLD, SIZE_TITLE)
    f_subtitle = ImageFont.truetype(FONT_CN_BOLD, SIZE_SUBTITLE)
    f_caption = ImageFont.truetype(FONT_CN_LIGHT, SIZE_CAPTION_CN)

    # 4) 第一行: "ShineWriter"
    draw_centered_text(img, "ShineWriter", f_title, Y_TITLE_LINE1,
                       fill=COLOR_TITLE, shadow=COLOR_SHADOW, offset=SHADOW_OFFSET)

    # 5) 第二行: "小说工作台"
    draw_centered_text(img, "小说工作台", f_subtitle, Y_TITLE_LINE2,
                       fill=COLOR_TITLE, shadow=COLOR_SHADOW, offset=SHADOW_OFFSET)

    # 6) 副标题
    draw_centered_text(img, SUBTITLE_TEXT, f_caption, Y_SUBTITLE,
                       fill=COLOR_SUBTITLE, shadow=COLOR_SHADOW, offset=TEXT_SHADOW_OFFSET)

    # 7) 第三行
    draw_centered_text(img, CAPTION_TEXT, f_caption, Y_CAPTION,
                       fill=COLOR_CAPTION, shadow=COLOR_SHADOW, offset=2)

    # 8) 装饰金线
    draw_hline(img, Y_LINE, LINE_WIDTH, LINE_THICKNESS, COLOR_LINE, img.size[0])

    # 9) 保存
    img.save(DST, "PNG", optimize=True)
    img.save(DST_ANDROID, "PNG", optimize=True)
    print("saved:", DST)
    print("saved:", DST_ANDROID)


if __name__ == "__main__":
    main()
