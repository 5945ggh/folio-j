# 原创合成 EPUB 夹具

本目录是编译器与阅读器测试使用的 EPUB 正本。文字与单像素图片由本仓库原创，运行 `python3 scripts/make_epub_fixtures.py` 可逐字节重建；生成器默认写入本目录。

`synthetic-reading.epub` 覆盖 ruby、重复句、Unicode 与内嵌图片；`synthetic-vertical.epub` 加入竖排和绝对定位样式；`synthetic-malicious.epub` 覆盖不安全资源与路径；`synthetic-fixed.epub` 声明不支持的全书固定版式。

日常人工验收选用 `synthetic-reading.epub`。这些测试夹具不进入用户源码发行包。
