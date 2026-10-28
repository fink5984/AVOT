using System.Text.Json.Serialization;

namespace AvotCapture.Core;

public sealed record PrintStock([property: JsonPropertyName("widthMm")] double WidthMm, [property: JsonPropertyName("heightMm")] double HeightMm);

public sealed record PrintPrinterRef(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("connection")] string Connection,
    [property: JsonPropertyName("host")] string? Host,
    [property: JsonPropertyName("port")] int Port,
    [property: JsonPropertyName("windowsName")] string? WindowsName,
    [property: JsonPropertyName("language")] string Language);

/// <summary>One label to draw (Windows-driver mode). Fields depend on <see cref="Type"/>: BOOK | LOCATION | ZONE | TEST.</summary>
public sealed record PrintLabelDto(
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("code")] string? Code,
    [property: JsonPropertyName("inventoryNumber")] string? InventoryNumber,
    [property: JsonPropertyName("title")] string? Title,
    [property: JsonPropertyName("path")] string? Path,
    [property: JsonPropertyName("shelf")] string? Shelf,
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("warehouse")] string? Warehouse,
    [property: JsonPropertyName("text")] string? Text);

/// <summary>A job claimed from the server. <c>Format</c> ZPL → <c>Zpl</c> goes to the printer as raw bytes; GDI → the labels are drawn through the Windows driver.</summary>
public sealed record ClaimedPrintJob(
    [property: JsonPropertyName("jobId")] string JobId,
    [property: JsonPropertyName("attempt")] int Attempt,
    [property: JsonPropertyName("labelCount")] int LabelCount,
    [property: JsonPropertyName("format")] string Format,
    [property: JsonPropertyName("printer")] PrintPrinterRef Printer,
    [property: JsonPropertyName("stock")] PrintStock Stock,
    [property: JsonPropertyName("copies")] int Copies,
    [property: JsonPropertyName("zpl")] string? Zpl,
    [property: JsonPropertyName("labels")] List<PrintLabelDto>? Labels);

public sealed record PrintClaimResponse([property: JsonPropertyName("job")] ClaimedPrintJob? Job);

public sealed record PrintQueueInfo([property: JsonPropertyName("pending")] int Pending, [property: JsonPropertyName("failedToday")] int FailedToday);

public sealed record PrintHeartbeatResponse([property: JsonPropertyName("queue")] PrintQueueInfo? Queue, [property: JsonPropertyName("printers")] List<PrintPrinterRef>? Printers);

public sealed record AgentPrinterResponse([property: JsonPropertyName("printer")] AgentPrinterInfo Printer);
public sealed record AgentPrinterInfo([property: JsonPropertyName("id")] string Id, [property: JsonPropertyName("name")] string Name, [property: JsonPropertyName("labelSize")] string LabelSize, [property: JsonPropertyName("language")] string Language, [property: JsonPropertyName("isPrimary")] bool IsPrimary);
public sealed record IdResponse([property: JsonPropertyName("id")] string Id);
