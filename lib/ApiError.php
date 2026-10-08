<?php
declare(strict_types=1);

/** Error API terstruktur: {"error":{"code","message","fields","details"}} */
final class ApiError extends Exception
{
    public const STATUS = ['validation' => 422, 'not_found' => 404, 'forbidden' => 403, 'unauthenticated' => 401,
        'conflict' => 409, 'rate_limited' => 429, 'server' => 500, 'bad_request' => 400, 'too_large' => 413,
        'precondition' => 428, 'method' => 405];

    public string $errCode;
    public array $fields;
    public array $details;
    public int $status;

    public function __construct(string $code, string $message, array $fields = [], array $details = [], ?int $status = null)
    {
        parent::__construct($message);
        $this->errCode = $code;
        $this->fields = $fields;
        $this->details = $details;
        $this->status = $status ?? (self::STATUS[$code] ?? 400);
    }

    public static function validation(array $fields, string $msg = 'Data tidak valid'): self { return new self('validation', $msg, $fields); }
    public static function notFound(string $what = 'Data'): self { return new self('not_found', $what . ' tidak ditemukan'); }
    public static function forbidden(string $msg = 'Tidak punya izin'): self { return new self('forbidden', $msg); }
    public static function conflict(string $msg, array $details = []): self { return new self('conflict', $msg, [], $details); }
}
