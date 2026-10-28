using AvotCapture.Core;
using Xunit;

namespace AvotCapture.Tests;

public class Code128Tests
{
    [Fact]
    public void Encodes_subset_B_with_the_standard_checksum()
    {
        // the same reference vector as the web app's test: (104 + Σ value·position) mod 103
        Assert.Equal([104, 55, 73, 75, 73, 80, 69, 68, 73, 65, 88, 106], Code128.Encode("Wikipedia"));
    }

    [Fact]
    public void Uses_subset_C_for_digit_runs_so_numeric_inventory_numbers_are_short()
    {
        var v = Code128.Encode("10000035");
        Assert.Equal(105, v[0]); // START C
        Assert.Equal([105, 10, 0, 0, 35], v[..5]);
        var sum = v[0];
        for (var i = 1; i < v.Length - 2; i++) sum += v[i] * i;
        Assert.Equal(sum % 103, v[^2]);
        Assert.Equal(106, v[^1]);
        // 4 data symbols + start + check + stop: far narrower than the old "ITM-000035"
        Assert.True(Code128.TotalModules("10000035") < Code128.TotalModules("ITM-000035"));
    }

    [Fact]
    public void Modules_alternate_bar_space_and_every_symbol_is_11_modules_wide_except_stop()
    {
        var modules = Code128.Modules("10000035");
        Assert.Equal(1, modules.Length % 2); // bar,space pairs, and the stop symbol has 7 elements: always an odd count
        Assert.All(modules, m => Assert.InRange(m, 1, 6));
        Assert.Equal(11 * (Code128.Encode("10000035").Length - 1) + 13, modules.Sum());
    }

    [Fact]
    public void Rejects_text_a_barcode_cannot_carry()
    {
        Assert.Throws<ArgumentException>(() => Code128.Encode("שלום"));
        Assert.Throws<ArgumentException>(() => Code128.Encode(""));
    }
}

public class PrintJournalTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "avot-journal-" + Guid.NewGuid().ToString("N"));
    private string File_ => Path.Combine(_dir, "journal.json");

    public void Dispose()
    {
        try { Directory.Delete(_dir, true); } catch { /* best effort */ }
    }

    [Fact]
    public void A_job_never_seen_is_printed()
    {
        Assert.Equal(PrintDecision.Print, new PrintJournal(File_).Decide("job-1"));
    }

    [Fact]
    public void A_job_already_sent_is_never_printed_again_even_after_the_app_restarts()
    {
        var j = new PrintJournal(File_);
        j.Mark("job-1", "sending");
        j.Mark("job-1", "sent");
        Assert.Equal(PrintDecision.ReportSentOnly, new PrintJournal(File_).Decide("job-1")); // a new instance = a restart
    }

    [Fact]
    public void A_crash_in_the_middle_of_sending_is_uncertain_and_is_never_resent_blindly()
    {
        new PrintJournal(File_).Mark("job-2", "sending");
        Assert.Equal(PrintDecision.FailUncertain, new PrintJournal(File_).Decide("job-2"));
    }

    [Fact]
    public void A_failure_before_anything_reached_the_printer_may_be_retried()
    {
        var j = new PrintJournal(File_);
        j.Mark("job-3", "sending");
        j.Mark("job-3", "failed", "המדפסת כבויה");
        Assert.Equal(PrintDecision.Retry, j.Decide("job-3"));
        Assert.Equal("המדפסת כבויה", j.Get("job-3")!.Error);
    }

    [Fact]
    public void The_journal_is_bounded_and_survives_a_corrupt_file()
    {
        var j = new PrintJournal(File_);
        for (var i = 0; i < 520; i++) j.Mark($"j{i}", "sent");
        Assert.True(j.Recent(1000).Count <= 500);
        File.WriteAllText(File_, "{ not json");
        Assert.Equal(PrintDecision.Print, new PrintJournal(File_).Decide("j1")); // starts empty instead of crashing the print service
    }
}
