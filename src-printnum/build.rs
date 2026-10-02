fn main() {
    // cargo сам отслеживает изменения .slint: slint_build::compile() выпускает
    // cargo:rerun-if-changed для всех подключённых файлов.
    slint_build::compile("ui/app.slint").expect("Slint build failed");

    // Иконка приложения, версия и манифест совместимости для Windows.
    //
    // ВАЖНО: компиляция ресурсов выполняется только в Windows-сборке
    // (должна идти на Windows, как в BUILD.bat / build-windows.bat).
    #[cfg(windows)]
    {
        let mut res = winres::WindowsResource::new();
        res.set_icon("assets/icon.ico");
        res.set("FileDescription", "PrintNum: Ozon Cells Printing Client");
        res.set("ProductName", "PrintNum");
        res.set("LegalCopyright", "PrintNum");

        // Манифест совместимости.
        //
        // supportedOS-guids перечисляют ОС, с которыми приложение официально
        // совместимо. Без этого манифеста Windows 7 может включать режим
        // совместимости и подменять поведение ряда функций
        // (в т.ч. системных метрик и DPI). Явное указание Win7/8/10 снимает
        // эту подмену и фиксирует единое поведение на всех поддерживаемых ОС.
        //
        // ВНИМАНИЕ: манифест НЕ включает Per-Monitor-DPI и не даёт доступа к
        // функциям, которых нет в системе. Отсутствующие в user32.dll Windows 7
        // функции (SystemParametersInfoForDpi) должны просто не вызываться —
        // это решается пином Slint =1.13.0 в Cargo.toml.
        res.set_manifest(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity
      type="win32"
      name="PrintNum"
      version="3.0.0.0"
      processorArchitecture="*"/>
  <description>PrintNum: Ozon Cells Printing Client</description>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <!-- Windows 7 -->
      <supportedOS Id="{35138b9a-5d96-4fbd-8e2d-a2440225f93a}"/>
      <!-- Windows 8 -->
      <supportedOS Id="{4a2f28e3-53b9-4441-ba9c-d69d4a4a6e38}"/>
      <!-- Windows 8.1 -->
      <supportedOS Id="{1f676c76-80e1-4239-95bb-83d0f6d0da78}"/>
      <!-- Windows 10 / 11 -->
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
    </application>
  </compatibility>
</assembly>"#,
        );

        let _ = res.compile();
    }
}
