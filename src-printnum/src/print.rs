//! Печать этикеток через GDI (Win32) + режим эмуляции.
//!
//! Полный перенос `backend/print_text.py` 1:1:
//! `prepare_label_data` → `calculate_dimensions` → `draw_header` → `draw_main_text`.
//!
//! Используется только Win32 GDI, доступный на Windows 7 x64.
//!
//! # Платформы
//!
//! - **Windows** — реальная печать через Win32 GDI.
//! - **macOS / Linux** — заглушка (только для разработки): `print_text`
//!   возвращает ошибку, кроме режима эмуляции (`dry-run`), где он просто
//!   логирует пропуск. BMP-превью не создаётся (нет GDI).
//!
//! # Режим эмуляции (`dry-run`)
//!
//! Если задан `PRINTNUM_DRY_RUN=1` или передан аргумент `--dry-run`, печать
//! не отправляется на принтер. Вместо этого этикетка рендерится offscreen в
//! memory DC (тот же GDI-код), сохраняется BMP-превью и JSON-отчёт в
//! каталоге `previews` рядом с `config.json` (см. `config::app_dir`).
//! Удобно проверять логику и вёрстку без принтера.

use crate::config::Config;

/// Результат бизнес-логики разбора текста (аналог dict из Python).
#[derive(Debug, Clone)]
pub struct LabelData {
    pub main_text: String,
    pub header_text: String,
    pub show_header: bool,
    pub force_left_header: bool,
    pub is_underlined: bool,
    pub is_bold: bool,
}

/// Бизнес-логика: парсинг, рокировка текстов, форматирование.
/// Полностью повторяет `prepare_label_data` из Python.
/// Платформонезависима и покрыта тестами в `tests/label_logic.rs`.
pub fn prepare_label_data(text: &str, config: &Config) -> LabelData {
    let end_line = config.end_line;
    let id_num = config.id_num;
    let hybrid = config.hybrid;
    let expand = config.expand;

    let mut split = text.splitn(2, '-');
    let raw_main = split.next().unwrap_or("");
    let raw_header = split.next().unwrap_or("");

    let is_numeric = !raw_main.is_empty() && raw_main.chars().all(|c| c.is_ascii_digit());
    let main_text_val: i64 = if is_numeric {
        raw_main.parse().unwrap_or(0)
    } else {
        0
    };

    // КГТ-1, КГТ-2, ... всегда считаются сработавшим условием hybrid + expand.
    let is_kgt = raw_main.to_uppercase() == "КГТ"
        && !raw_header.is_empty()
        && raw_header.chars().all(|c| c.is_ascii_digit());

    let is_bold = (hybrid && is_numeric && main_text_val >= expand) || is_kgt;
    let is_swapped = is_bold;

    let (main_text, header_text, show_header, force_left_header);
    if is_swapped {
        header_text = raw_main.to_string();
        main_text = raw_header.to_string();
        force_left_header = true;
        show_header = true;
    } else {
        main_text = raw_main.to_string();
        show_header = !raw_header.is_empty() && id_num;
        header_text = if show_header {
            raw_header.to_string()
        } else {
            String::new()
        };
        force_left_header = false;
    }

    // Дефисы у header.
    let header_text = if show_header && !header_text.is_empty() {
        if force_left_header {
            format!("{header_text}-")
        } else {
            format!("-{header_text}")
        }
    } else {
        header_text
    };

    let (main_text, is_underlined) = if end_line {
        (main_text, true)
    } else {
        (format!("{main_text}."), false)
    };

    LabelData {
        main_text,
        header_text,
        show_header,
        force_left_header,
        is_underlined,
        is_bold,
    }
}

/// Включён ли режим эмуляции печати.
///
/// Управляется переменной окружения `PRINTNUM_DRY_RUN`
/// (значения `1`, `true`, `yes`, `on` — включено).
pub fn is_dry_run() -> bool {
    matches!(
        std::env::var("PRINTNUM_DRY_RUN")
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// Заглушка для macOS/Linux (только для разработки).
#[cfg(not(windows))]
pub fn print_text(_text: &str, _config: &Config) -> Result<(), String> {
    if is_dry_run() {
        eprintln!("[dry-run] Печать пропущена (эмуляция не поддерживается вне Windows)");
        return Ok(());
    }
    Err("Печать поддерживается только на Windows".into())
}

#[cfg(windows)]
mod win_impl {
    use super::*;
    use crate::printer::clear_printer_queue;

    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, CreateDCW, CreateFontW, DeleteDC, DeleteObject,
        GetDeviceCaps, GetTextExtentPoint32W, SelectObject, SetBkMode, TextOutW, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET,
        DEFAULT_PITCH, DIB_RGB_COLORS, FF_DONTCARE, FW_BOLD, FW_NORMAL, HBITMAP, HDC, HGDIOBJ,
        LOGPIXELSX, LOGPIXELSY, OUT_DEFAULT_PRECIS, TRANSPARENT,
    };
    use windows::Win32::Storage::Xps::{AbortDoc, DOCINFOW, EndDoc, EndPage, StartDocW, StartPage};

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// Физические размеры (мм) → пиксели принтера + отступы 5%.
    #[derive(Debug, Clone, Copy)]
    struct Sizes {
        width_px: i32,
        height_px: i32,
        margin_x: i32,
        margin_y: i32,
        max_allowed_w: i32,
    }

    fn calculate_dimensions(hdc: HDC, paper: &str) -> Option<Sizes> {
        let (w_mm, h_mm) = parse_paper(paper)?;

        let dpi_x = unsafe { GetDeviceCaps(hdc, LOGPIXELSX) };
        let dpi_y = unsafe { GetDeviceCaps(hdc, LOGPIXELSY) };

        Some(dimensions_from_dpi(w_mm, h_mm, dpi_x, dpi_y))
    }

    fn dimensions_from_dpi(w_mm: i32, h_mm: i32, dpi_x: i32, dpi_y: i32) -> Sizes {
        let width_px = ((w_mm as f64 / 25.4) * dpi_x as f64) as i32;
        let height_px = ((h_mm as f64 / 25.4) * dpi_y as f64) as i32;

        let margin_x = (width_px as f64 * 0.05) as i32;
        let margin_y = (height_px as f64 * 0.05) as i32;

        Sizes {
            width_px,
            height_px,
            margin_x,
            margin_y,
            max_allowed_w: width_px - margin_x * 2,
        }
    }

    fn parse_paper(paper: &str) -> Option<(i32, i32)> {
        let mut parts = paper.split('*');
        let w = parts.next()?.trim().parse().ok()?;
        let h = parts.next()?.trim().parse().ok()?;
        Some((w, h))
    }

    fn create_font(
        height: i32,
        weight: i32,
        underline: bool,
    ) -> windows::Win32::Graphics::Gdi::HFONT {
        let face = to_wide("Arial");
        unsafe {
            CreateFontW(
                height,
                0,
                0,
                0,
                weight,
                0,
                if underline { 1 } else { 0 },
                0,
                DEFAULT_CHARSET.0 as u32,
                OUT_DEFAULT_PRECIS.0 as u32,
                CLIP_DEFAULT_PRECIS.0 as u32,
                CLEARTYPE_QUALITY.0 as u32,
                (DEFAULT_PITCH.0 | FF_DONTCARE.0) as u32,
                PCWSTR(face.as_ptr()),
            )
        }
    }

    fn text_extent(hdc: HDC, text: &str) -> (i32, i32) {
        let wide: Vec<u16> = OsStr::new(text).encode_wide().collect();
        let mut size = SIZE::default();
        unsafe {
            let _ = GetTextExtentPoint32W(hdc, &wide, &mut size);
        }
        (size.cx, size.cy)
    }

    /// Рендер верхнего колонтитула. Возвращает Y после header.
    fn draw_header(hdc: HDC, text: &str, sizes: &Sizes, force_left: bool) -> i32 {
        let font = create_font((sizes.height_px as f64 * 0.20) as i32, FW_NORMAL.0 as i32, false);
        let old = unsafe { SelectObject(hdc, HGDIOBJ(font.0)) };

        let (text_w, text_h) = text_extent(hdc, text);
        let x = if force_left {
            sizes.margin_x
        } else {
            sizes.width_px - text_w - sizes.margin_x
        };
        let y = sizes.margin_y;

        let wide: Vec<u16> = OsStr::new(text).encode_wide().collect();
        unsafe {
            let _ = TextOutW(hdc, x, y, &wide);
            SelectObject(hdc, old);
            let _ = DeleteObject(HGDIOBJ(font.0));
        }
        y + text_h
    }

    /// Результат рендера центрального текста.
    struct MainRender {
        height: i32,
        x: i32,
        y: i32,
        width: i32,
        text_height: i32,
    }

    /// Рендер и автоподбор размера центрального текста.
    fn draw_main_text(
        hdc: HDC,
        text: &str,
        sizes: &Sizes,
        y_start: i32,
        is_underlined: bool,
        is_bold: bool,
    ) -> MainRender {
        let available_h = sizes.height_px - y_start - sizes.margin_y;
        let mut optimal_height = 10;
        let weight = if is_bold { FW_BOLD.0 as i32 } else { FW_NORMAL.0 as i32 };

        // Подбор максимального размера шрифта.
        loop {
            let test_font = create_font(optimal_height, weight, is_underlined);
            let old = unsafe { SelectObject(hdc, HGDIOBJ(test_font.0)) };
            let (w, h) = text_extent(hdc, text);
            unsafe {
                SelectObject(hdc, old);
                let _ = DeleteObject(HGDIOBJ(test_font.0));
            }

            if w > sizes.max_allowed_w || h > available_h {
                optimal_height -= 1;
                break;
            }
            optimal_height += 1;
        }

        let final_font = create_font(optimal_height, weight, is_underlined);
        let old = unsafe { SelectObject(hdc, HGDIOBJ(final_font.0)) };
        let (text_w, text_h) = text_extent(hdc, text);

        let x = (sizes.width_px - text_w) / 2;
        let y = y_start + (available_h - text_h) / 2;

        let wide: Vec<u16> = OsStr::new(text).encode_wide().collect();
        unsafe {
            let _ = TextOutW(hdc, x, y, &wide);
            SelectObject(hdc, old);
            let _ = DeleteObject(HGDIOBJ(final_font.0));
        }

        MainRender {
            height: optimal_height,
            x,
            y,
            width: text_w,
            text_height: text_h,
        }
    }

    /// Рисует этикетку на переданном DC. Возвращает вычисленные параметры.
    /// Используется и для печати, и для эмуляции — код один и тот же.
    fn draw_label(hdc: HDC, text: &str, config: &Config, data: &LabelData) -> Result<serde_json::Value, String> {
        unsafe { SetBkMode(hdc, TRANSPARENT) };
        let sizes = calculate_dimensions(hdc, &config.paper)
            .ok_or_else(|| format!("Некорректный размер этикетки '{}'", config.paper))?;

        let mut y_start_center = sizes.margin_y;
        if data.show_header && !data.header_text.is_empty() {
            y_start_center = draw_header(hdc, &data.header_text, &sizes, data.force_left_header);
        }

        let main = draw_main_text(
            hdc,
            &data.main_text,
            &sizes,
            y_start_center,
            data.is_underlined,
            data.is_bold,
        );

        Ok(serde_json::json!({
            "text": text,
            "main_text": data.main_text,
            "header_text": data.header_text,
            "show_header": data.show_header,
            "force_left_header": data.force_left_header,
            "is_bold": data.is_bold,
            "is_underlined": data.is_underlined,
            "paper": config.paper,
            "label_px": { "width": sizes.width_px, "height": sizes.height_px },
            "margin_px": { "x": sizes.margin_x, "y": sizes.margin_y },
            "main_font_height_px": main.height,
            "main_rect": { "x": main.x, "y": main.y, "w": main.width, "h": main.text_height },
        }))
    }

    /// Главная функция печати (оркестратор), аналог `print_text`.
    /// В режиме эмуляции (`is_dry_run`) не отправляет на принтер, а рендерит превью.
    pub fn print_text(text: &str, config: &Config) -> Result<(), String> {
        let data = super::prepare_label_data(text, config);

        if super::is_dry_run() {
            return emulate(text, config, &data);
        }

        let printer_name = config.printer.trim();
        if printer_name.is_empty() {
            return Err("Принтер не выбран".into());
        }

        clear_printer_queue(printer_name);

        let driver = to_wide(printer_name);
        let hdc: HDC = unsafe {
            CreateDCW(
                PCWSTR(driver.as_ptr()),
                PCWSTR(driver.as_ptr()),
                PCWSTR::null(),
                None,
            )
        };
        if hdc.is_invalid() {
            return Err(format!("Не удалось создать DC для принтера '{printer_name}'"));
        }

        let doc_name = to_wide(&format!("Ячейка: {text}"));
        let doc_info = DOCINFOW {
            cbSize: std::mem::size_of::<DOCINFOW>() as i32,
            lpszDocName: PCWSTR(doc_name.as_ptr()),
            ..Default::default()
        };

        let result = (|| -> Result<serde_json::Value, String> {
            if unsafe { StartDocW(hdc, &doc_info) } <= 0 {
                return Err("StartDocW не удался".into());
            }
            if unsafe { StartPage(hdc) } <= 0 {
                unsafe {
                    let _ = AbortDoc(hdc);
                }
                return Err("StartPage не удался".into());
            }

            let report = draw_label(hdc, text, config, &data)?;

            unsafe {
                let _ = EndPage(hdc);
                let _ = EndDoc(hdc);
            }
            Ok(report)
        })();

        unsafe {
            let _ = DeleteDC(hdc);
        }

        match result {
            Ok(report) => {
                println!(
                    "Отправлено. Шрифт: {}px. Жирный: {}. Текст хедера: '{}'",
                    report["main_font_height_px"], data.is_bold, data.header_text
                );
                Ok(())
            }
            Err(e) => {
                eprintln!("Ошибка при печати: {e}");
                Err(e)
            }
        }
    }

    /// DPI, используемый для offscreen-эмуляции (типичный термопринтер).
    const EMULATED_DPI: i32 = 203;

    /// Режим эмуляции: рендерит этикетку в memory DC, сохраняет BMP и JSON-отчёт.
    fn emulate(text: &str, config: &Config, data: &LabelData) -> Result<(), String> {
        let (w_mm, h_mm) = parse_paper(&config.paper)
            .ok_or_else(|| format!("Некорректный размер этикетки '{}'", config.paper))?;
        let sizes = dimensions_from_dpi(w_mm, h_mm, EMULATED_DPI, EMULATED_DPI);

        // Memory DC + 24-битный DIB.
        let screen = unsafe { CreateCompatibleDC(None) };
        if screen.is_invalid() {
            return Err("Не удалось создать memory DC".into());
        }

        let bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: sizes.width_px,
                biHeight: -sizes.height_px, // top-down
                biPlanes: 1,
                biBitCount: 24,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };

        let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
        let bitmap: HBITMAP = match unsafe {
            CreateDIBSection(screen, &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
        } {
            Ok(b) => b,
            Err(e) => {
                unsafe { let _ = DeleteDC(screen); }
                return Err(format!("CreateDIBSection: {e}"));
            }
        };

        let old_bitmap = unsafe { SelectObject(screen, HGDIOBJ(bitmap.0)) };

        // Белый фон.
        unsafe {
            let _ = windows::Win32::Graphics::Gdi::PatBlt(
                screen,
                0,
                0,
                sizes.width_px,
                sizes.height_px,
                windows::Win32::Graphics::Gdi::WHITENESS,
            );
        }

        let report = draw_label(screen, text, config, data);

        // Считываем пиксели (top-down BGR, 24 бита) прямо из DIB-секции.
        // Строки DIB выровнены до 4 байт: stride = (width*3 + 3) & !3.
        let pixels = unsafe {
            let stride = ((sizes.width_px as usize * 3 + 3) & !3) * sizes.height_px as usize;
            if bits.is_null() {
                Vec::new()
            } else {
                std::slice::from_raw_parts(bits as *const u8, stride).to_vec()
            }
        };

        unsafe {
            SelectObject(screen, old_bitmap);
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            let _ = DeleteDC(screen);
        }

        let report = report?;

        // BMP из top-down BGR-пикселей.
        let bmp = build_bmp(&sizes, &pixels);

        // Путь отчёта.
        let dir = crate::config::app_dir().join("previews");
        let _ = std::fs::create_dir_all(&dir);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let sanitized: String = text
            .chars()
            .map(|c| if c.is_alphanumeric() || c == '-' { c } else { '_' })
            .collect();

        let json_path = dir.join(format!("label_{sanitized}_{stamp}.json"));
        let bmp_path = dir.join(format!("label_{sanitized}_{stamp}.bmp"));

        if let Ok(json) = serde_json::to_string_pretty(&report) {
            let _ = std::fs::write(&json_path, json);
        }
        let _ = std::fs::write(&bmp_path, bmp);

        println!("[dry-run] Этикетка отрендерена (печать не выполнялась).");
        println!("[dry-run] Шрифт: {}px, жирный: {}", report["main_font_height_px"], data.is_bold);
        println!("[dry-run] Отчёт: {}", json_path.display());
        println!("[dry-run] Превью: {}", bmp_path.display());
        Ok(())
    }

    /// Собирает BMP-файл из top-down BGR-пикселей (24 бита).
    fn build_bmp(sizes: &Sizes, top_down_bgr: &[u8]) -> Vec<u8> {
        let row_raw = sizes.width_px as usize * 3;
        let row_padded = (row_raw + 3) & !3;
        let height = sizes.height_px as usize;
        let pixel_bytes = row_padded * height;

        let mut out = Vec::with_capacity(54 + pixel_bytes);
        let file_size = (54 + pixel_bytes) as u32;

        // BITMAPFILEHEADER (14 байт).
        out.extend_from_slice(b"BM");
        out.extend_from_slice(&file_size.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&54u32.to_le_bytes());

        // BITMAPINFOHEADER (40 байт), height положительная (bottom-up в BMP).
        out.extend_from_slice(&40u32.to_le_bytes());
        out.extend_from_slice(&sizes.width_px.to_le_bytes());
        out.extend_from_slice(&sizes.height_px.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&24u16.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(pixel_bytes as u32).to_le_bytes());
        out.extend_from_slice(&2835i32.to_le_bytes());
        out.extend_from_slice(&2835i32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());

        // BMP хранит строки снизу вверх. Источник — top-down DIB (stride = row_padded).
        for row in (0..height).rev() {
            let start = row * row_padded;
            let end = start + row_padded;
            if end <= top_down_bgr.len() {
                out.extend_from_slice(&top_down_bgr[start..end]);
            } else {
                out.extend(std::iter::repeat(0u8).take(row_padded));
            }
        }
        out
    }
}

#[cfg(windows)]
pub use win_impl::print_text;