# -*- coding: utf-8 -*-
import os
import shutil

media_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'media')
print("Checking media dir:", media_dir)

if os.path.exists(media_dir):
    std_cats = ['待机', '音乐', '图片', '视频', '文档', '网页', '流码']
    for std in std_cats:
        os.makedirs(os.path.join(media_dir, std), exist_ok=True)

    # 1. PPT_PDF -> 文档
    old_doc = os.path.join(media_dir, 'PPT_PDF')
    target_doc = os.path.join(media_dir, '文档')
    if os.path.exists(old_doc) and os.path.isdir(old_doc):
        for f in os.listdir(old_doc):
            src = os.path.join(old_doc, f)
            dst = os.path.join(target_doc, f)
            if not os.path.exists(dst):
                shutil.move(src, dst)
                print(f"[Migrate] 移动文档: {f} -> 文档")
            else:
                try: os.remove(src)
                except Exception: pass
        try:
            os.rmdir(old_doc)
            print("[Migrate] 已清理旧目录 PPT_PDF")
        except Exception as e:
            print("[Migrate] 清理 PPT_PDF 异常:", e)

    # 2. 网页_流码 -> 网页 / 流码
    old_web_stream = os.path.join(media_dir, '网页_流码')
    target_web = os.path.join(media_dir, '网页')
    target_stream = os.path.join(media_dir, '流码')
    if os.path.exists(old_web_stream) and os.path.isdir(old_web_stream):
        for f in os.listdir(old_web_stream):
            src = os.path.join(old_web_stream, f)
            is_stream = False
            ext = os.path.splitext(f)[1].lower()
            if ext in ['.m3u8']:
                is_stream = True
            elif ext in ['.txt', '.url']:
                try:
                    with open(src, 'r', encoding='utf-8', errors='ignore') as fp:
                        content = fp.read().lower()
                        if 'rtsp://' in content or 'rtmp://' in content or '.m3u8' in content:
                            is_stream = True
                except Exception:
                    pass
            dst_dir = target_stream if is_stream else target_web
            dst = os.path.join(dst_dir, f)
            if not os.path.exists(dst):
                shutil.move(src, dst)
                print(f"[Migrate] 移动素材: {f} -> {'流码' if is_stream else '网页'}")
            else:
                try: os.remove(src)
                except Exception: pass
        try:
            os.rmdir(old_web_stream)
            print("[Migrate] 已清理旧目录 网页_流码")
        except Exception as e:
            print("[Migrate] 清理 网页_流码 异常:", e)

print("Migration completed. Current categories:", [d for d in os.listdir(media_dir) if os.path.isdir(os.path.join(media_dir, d))])
