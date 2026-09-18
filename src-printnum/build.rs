fn main() {
    slint_build::compile("ui/app.slint").expect("Slint build failed");

    // Иконка приложения и ресурсы для Windows.
    #[cfg(windows)]
    {
        let mut res = winres::WindowsResource::new();
        res.set_icon("assets/icon.ico");
        res.set("FileDescription", "PrintNum — Печать ячеек");
        res.set("ProductName", "PrintNum");
        res.set("LegalCopyright", "PrintNum");
        let _ = res.compile();
    }
}
