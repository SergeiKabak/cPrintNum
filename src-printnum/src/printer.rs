//! Работа с принтерами через Win32 Spooler API.
//!
//! Полный аналог прежнего `backend/utils.py` (pywin32):
//! - `list_printers`   — EnumPrinters(LOCAL | CONNECTIONS)
//! - `status_printer`  — OpenPrinter + GetPrinter(level 2) + проверка флагов
//! - `clear_printer_queue` — OpenPrinter(ADMINISTER) + SetPrinter(PURGE)
//!
//! # Платформы
//!
//! - **Windows** — реальная реализация через Win32 Spooler.
//! - **macOS / Linux** — заглушки (только для разработки): список принтеров
//!   пустой, статус всегда `false`, очистка очереди невозможна.


#[cfg(not(windows))]
mod win_impl {
    /// Заглушка для macOS/Linux (только для разработки): список принтеров пуст.
    pub fn list_printers() -> Vec<String> {
        Vec::new()
    }

    /// Заглушка для macOS/Linux (только для разработки): принтер всегда недоступен.
    pub fn status_printer(_name: &str) -> bool {
        false
    }

    /// Заглушка для macOS/Linux (только для разработки).
    pub fn clear_printer_queue(_name: &str) -> bool {
        false
    }
}

#[cfg(windows)]
mod win_impl {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Graphics::Printing::{
        ClosePrinter, EnumPrintersW, GetPrinterW, OpenPrinterW, SetPrinterW, PRINTER_ACCESS_ADMINISTER,
        PRINTER_CONTROL_PURGE, PRINTER_DEFAULTSW, PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL,
        PRINTER_INFO_2W, PRINTER_STATUS_ERROR, PRINTER_STATUS_OFFLINE, PRINTER_STATUS_PAPER_JAM,
        PRINTER_STATUS_PAPER_OUT,
    };

    /// Флаг «принтер отключён» (PRINTER_ATTRIBUTE_WORK_OFFLINE).
    const PRINTER_ATTRIBUTE_WORK_OFFLINE: u32 = 0x0000_0400;

    fn to_wide(s: &str) -> Vec<u16> {
        OsString::from(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    fn from_wide(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        OsString::from_wide(&buf[..end]).to_string_lossy().to_string()
    }

    /// Список подключённых принтеров (локальные + сетевые).
    pub fn list_printers() -> Vec<String> {
        unsafe {
            let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
            let mut needed: u32 = 0;
            let mut returned: u32 = 0;

            // Первый вызов — узнать размер буфера.
            let _ = EnumPrintersW(flags, PCWSTR::null(), 4, None, &mut needed, &mut returned);
            if needed == 0 {
                return Vec::new();
            }

            let mut buffer = vec![0u8; needed as usize];
            if EnumPrintersW(
                flags,
                PCWSTR::null(),
                4,
                Some(&mut buffer),
                &mut needed,
                &mut returned,
            )
            .is_err()
            {
                return Vec::new();
            }

            // level 4 = PRINTER_INFO_4W { pPrinterName, pServerName, Attributes }
            #[repr(C)]
            struct PrinterInfo4W {
                p_printer_name: *mut u16,
                p_server_name: *mut u16,
                attributes: u32,
            }

            let infos = std::slice::from_raw_parts(
                buffer.as_ptr() as *const PrinterInfo4W,
                returned as usize,
            );

            let mut out = Vec::with_capacity(infos.len());
            for info in infos {
                if !info.p_printer_name.is_null() {
                    let mut len = 0usize;
                    while *info.p_printer_name.add(len) != 0 {
                        len += 1;
                    }
                    let slice = std::slice::from_raw_parts(info.p_printer_name, len + 1);
                    out.push(from_wide(slice));
                }
            }
            out
        }
    }

    /// Проверяет, доступен ли принтер (не offline, без аппаратных ошибок).
    pub fn status_printer(printer_name: &str) -> bool {
        let name = printer_name.trim();
        if name.is_empty() {
            return false;
        }
        unsafe {
            let wide = to_wide(name);
            let mut handle = HANDLE::default();
            if OpenPrinterW(PCWSTR(wide.as_ptr()), &mut handle, None).is_err() {
                return false;
            }

            let result = (|| -> bool {
                let mut needed: u32 = 0;
                let _ = GetPrinterW(handle, 2, None, &mut needed);
                if needed == 0 {
                    return false;
                }
                let mut buffer = vec![0u8; needed as usize];
                let mut got: u32 = 0;
                if GetPrinterW(handle, 2, Some(&mut buffer), &mut got).is_err() {
                    return false;
                }
                let info = &*(buffer.as_ptr() as *const PRINTER_INFO_2W);

                // 1. Физическое отключение.
                if (info.Attributes & PRINTER_ATTRIBUTE_WORK_OFFLINE) != 0 {
                    return false;
                }

                // 2. Аппаратные ошибки.
                let critical = PRINTER_STATUS_ERROR
                    | PRINTER_STATUS_PAPER_JAM
                    | PRINTER_STATUS_PAPER_OUT
                    | PRINTER_STATUS_OFFLINE;
                if (info.Status & critical) != 0 {
                    return false;
                }
                true
            })();

            let _ = ClosePrinter(handle);
            result
        }
    }

    /// Полностью очищает очередь печати указанного принтера.
    pub fn clear_printer_queue(printer_name: &str) -> bool {
        let name = printer_name.trim();
        if name.is_empty() {
            return false;
        }
        unsafe {
            let wide = to_wide(name);
            let mut handle = HANDLE::default();
            let mut defaults = PRINTER_DEFAULTSW::default();
            defaults.DesiredAccess = PRINTER_ACCESS_ADMINISTER;

            if OpenPrinterW(PCWSTR(wide.as_ptr()), &mut handle, Some(&defaults)).is_err() {
                return false;
            }

            let ok = SetPrinterW(handle, 0, None, PRINTER_CONTROL_PURGE).is_ok();
            let _ = ClosePrinter(handle);
            ok
        }
    }
}

pub use win_impl::*;
