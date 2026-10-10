using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("ABxAG")]
[assembly: AssemblyDescription("ABxAG Desktop Companion Launcher")]
[assembly: AssemblyProduct("ABxAG")]
[assembly: AssemblyCompany("ABsUP")]
[assembly: AssemblyCopyright("Copyright © 2026 ABsUP")]
[assembly: AssemblyVersion("1.0.1.0")]
[assembly: AssemblyFileVersion("1.0.1.0")]

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        string baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
        string runtimePath = Path.Combine(baseDirectory, "ABxAG-runtime.exe");

        if (!File.Exists(runtimePath))
        {
            MessageBox.Show(
                "ABxAG-runtime.exe is missing. Reinstall ABxAG and try again.",
                "ABxAG failed to start",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }

        try
        {
            // Electron rejects several globally configured Node flags before the
            // JavaScript main process starts. Keep those flags out of ABxAG while
            // leaving the user's system-wide configuration untouched.
            Environment.SetEnvironmentVariable("NODE_OPTIONS", null, EnvironmentVariableTarget.Process);
            Environment.SetEnvironmentVariable("ELECTRON_RUN_AS_NODE", null, EnvironmentVariableTarget.Process);

            var startInfo = new ProcessStartInfo
            {
                FileName = runtimePath,
                Arguments = JoinArguments(args),
                WorkingDirectory = baseDirectory,
                UseShellExecute = false,
            };
            Process runtime = Process.Start(startInfo);
            if (runtime == null) return 1;

            // The electron-builder portable wrapper owns a temporary extracted
            // directory and removes it as soon as ABxAG.exe exits. Keep this
            // lightweight launcher alive until Electron closes so the portable
            // runtime and its bundled desktop agent remain available.
            runtime.WaitForExit();
            return runtime.ExitCode;
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "ABxAG could not be launched.\r\n\r\n" + error.Message,
                "ABxAG failed to start",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }
    }

    private static string JoinArguments(string[] args)
    {
        if (args == null || args.Length == 0) return string.Empty;
        var quoted = new string[args.Length];
        for (int index = 0; index < args.Length; index++)
        {
            string value = args[index] ?? string.Empty;
            quoted[index] = "\"" + value.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }
        return string.Join(" ", quoted);
    }
}

