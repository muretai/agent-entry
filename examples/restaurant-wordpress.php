<?php
/**
 * Plugin Name: Restaurant Agent Entry
 * Description: One-file signed restaurant reservation door for WordPress.
 * Version: 1.0.0
 * License: MIT
 *
 * Install this file in wp-content/plugins/restaurant-agent-entry/restaurant-agent-entry.php,
 * activate it, and keep PHP sodium enabled. WordPress keeps GET /; this plugin answers the
 * two card paths and an exact POST / with no query string.
 */

if (!defined('ABSPATH')) {
    exit;
}

const MAE_RESTAURANT_CARD = '/.well-known/agent-card.json';
const MAE_RESTAURANT_CARD_LEGACY = '/.well-known/agent.json';
const MAE_RESTAURANT_SIG = '/.well-known/agent-card.sig.json';

function mae_restaurant_json($value) {
    if (is_array($value)) {
        $keys = array_keys($value);
        $list = count($value) === 0 || $keys === range(0, count($value) - 1);
        if ($list) {
            return '[' . implode(',', array_map('mae_restaurant_json', $value)) . ']';
        }
        usort($keys, 'strcmp');
        $parts = array();
        foreach ($keys as $key) {
            $parts[] = mae_restaurant_json((string) $key) . ':' . mae_restaurant_json($value[$key]);
        }
        return '{' . implode(',', $parts) . '}';
    }
    $json = wp_json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($json === false) {
        throw new RuntimeException('value cannot be encoded as canonical JSON');
    }
    return $json;
}

function mae_restaurant_b58_encode($raw) {
    $alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    $digits = array(0);
    foreach (array_values(unpack('C*', $raw)) as $byte) {
        $carry = $byte;
        for ($i = 0; $i < count($digits); $i++) {
            $carry += $digits[$i] * 256;
            $digits[$i] = $carry % 58;
            $carry = intdiv($carry, 58);
        }
        while ($carry > 0) {
            $digits[] = $carry % 58;
            $carry = intdiv($carry, 58);
        }
    }
    $out = '';
    for ($i = count($digits) - 1; $i >= 0; $i--) {
        $out .= $alphabet[$digits[$i]];
    }
    return $out;
}

function mae_restaurant_b58_decode($text) {
    $alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    $bytes = array(0);
    for ($p = 0; $p < strlen($text); $p++) {
        $value = strpos($alphabet, $text[$p]);
        if ($value === false) {
            return null;
        }
        $carry = $value;
        for ($i = 0; $i < count($bytes); $i++) {
            $carry += $bytes[$i] * 58;
            $bytes[$i] = $carry & 255;
            $carry = intdiv($carry, 256);
        }
        while ($carry > 0) {
            $bytes[] = $carry & 255;
            $carry = intdiv($carry, 256);
        }
    }
    $out = '';
    for ($i = count($bytes) - 1; $i >= 0; $i--) {
        $out .= chr($bytes[$i]);
    }
    return $out;
}

function mae_restaurant_seed() {
    if (!function_exists('sodium_crypto_sign_seed_keypair')) {
        throw new RuntimeException('Restaurant Agent Entry requires the PHP sodium extension.');
    }
    $encoded = get_option('mae_restaurant_seed', '');
    $seed = base64_decode($encoded, true);
    if ($seed !== false && strlen($seed) === SODIUM_CRYPTO_SIGN_SEEDBYTES) {
        return $seed;
    }
    $seed = random_bytes(SODIUM_CRYPTO_SIGN_SEEDBYTES);
    update_option('mae_restaurant_seed', base64_encode($seed), false);
    return $seed;
}

function mae_restaurant_identity() {
    $seed = mae_restaurant_seed();
    $pair = sodium_crypto_sign_seed_keypair($seed);
    $public = sodium_crypto_sign_publickey($pair);
    return array(
        'seed' => $seed,
        'secret' => sodium_crypto_sign_secretkey($pair),
        'public' => $public,
        'did' => 'did:key:z' . mae_restaurant_b58_encode("\xed\x01" . $public),
    );
}

function mae_restaurant_public_from_did($did) {
    if (!is_string($did) || strpos($did, 'did:key:z') !== 0) {
        return null;
    }
    $raw = mae_restaurant_b58_decode(substr($did, 9));
    if ($raw === null || strlen($raw) !== 34 || substr($raw, 0, 2) !== "\xed\x01") {
        return null;
    }
    return substr($raw, 2);
}

function mae_restaurant_requirement($did, $endpoint) {
    return array(
        'scheme' => 'did-key-ed25519',
        'instruction' => 'Sign one A2A message/send with an Ed25519 did:key. No invitation or account is required.',
        'in' => 'params.message.metadata',
        'recipient' => $did,
        'endpoint' => $endpoint,
        'identity' => 'did:key:z + base58btc(0xed01 || 32-byte Ed25519 public key)',
        'signedFields' => array('contextId', 'from', 'messageId', 'text', 'timestamp', 'to'),
        'canonicalization' => 'JSON object of exactly the six signed fields, keys sorted by Unicode code point, compact separators, UTF-8',
        'signature' => 'standard padded base64 of the 64-byte Ed25519 signature',
        'timestamp' => 'integer epoch seconds within 300 seconds',
    );
}

function mae_restaurant_card() {
    $id = mae_restaurant_identity();
    $base = untrailingslashit(home_url('/'));
    $requirement = mae_restaurant_requirement($id['did'], $base . '/');
    return array(
        'protocolVersion' => '0.2',
        'name' => get_bloginfo('name') . ' Reservations',
        'description' => 'Accepts signed table reservation requests.',
        'url' => $base,
        'did' => $id['did'],
        'version' => '1',
        'capabilities' => array('streaming' => false, 'pushNotifications' => false),
        'defaultInputModes' => array('text/plain'),
        'defaultOutputModes' => array('text/plain'),
        'skills' => array(array(
            'id' => 'reserve-table',
            'name' => 'restaurant-reservation',
            'description' => 'Request a table by date, time and party size.',
            'tags' => array('restaurant', 'reservation', 'booking'),
            'examples' => array('Request a table for 4 on 2026-09-15 at 19:00'),
        )),
        'agentEntry' => array('open_door' => true, 'catalog' => true),
        'muretai' => array('open_door' => true),
        'securitySchemes' => array('did-key-ed25519' => array(
            'type' => 'did-key-ed25519',
            'description' => 'Sign the message with an Ed25519 did:key.',
            'agentEntry' => $requirement,
            'muretai' => $requirement,
        )),
        'security' => array(array('did-key-ed25519' => array())),
        'supportedInterfaces' => array(array(
            'url' => $base . '/',
            'protocolBinding' => 'JSONRPC',
            'protocolVersion' => '0.2',
        )),
    );
}

function mae_restaurant_text($message) {
    $texts = array();
    foreach (($message['parts'] ?? array()) as $part) {
        if (is_array($part) && ($part['kind'] ?? '') === 'text' && is_string($part['text'] ?? null)) {
            $texts[] = $part['text'];
        }
    }
    return implode("\n", $texts);
}

function mae_restaurant_send($status, $body) {
    status_header($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Access-Control-Allow-Origin: *');
    echo wp_json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function mae_restaurant_error($id, $code, $message, $data = null) {
    $error = array('code' => $code, 'message' => $message);
    if ($data !== null) {
        $error['data'] = $data;
    }
    mae_restaurant_send(200, array('jsonrpc' => '2.0', 'id' => $id, 'error' => $error));
}

function mae_restaurant_handle_post() {
    $request = json_decode(file_get_contents('php://input'), true);
    $id = is_array($request) ? ($request['id'] ?? null) : null;
    $message = is_array($request) ? ($request['params']['message'] ?? null) : null;
    if (($request['method'] ?? null) !== 'message/send' || !is_array($message)) {
        mae_restaurant_error($id, -32602, 'Invalid message/send request');
    }
    $meta = is_array($message['metadata'] ?? null) ? $message['metadata'] : array();
    $from = $meta['from'] ?? null;
    $to = $meta['to'] ?? null;
    $sig64 = $meta['sig'] ?? null;
    $card = mae_restaurant_card();
    $requirement = $card['securitySchemes']['did-key-ed25519']['agentEntry'];
    if (!$from || !$to || !$sig64) {
        mae_restaurant_error($id, -32001, 'Signature verification failed', array(
            'detail' => 'missing signing envelope (from/to/sig)',
            'accepts' => array($requirement),
        ));
    }
    if ($to !== $card['did']) {
        mae_restaurant_error($id, -32003, 'Wrong recipient');
    }
    $timestamp = $meta['timestamp'] ?? null;
    if (!is_int($timestamp) || abs(time() - $timestamp) > 300) {
        mae_restaurant_error($id, -32002, 'Timestamp out of range');
    }
    $public = mae_restaurant_public_from_did($from);
    $sig = is_string($sig64) ? base64_decode($sig64, true) : false;
    $text = mae_restaurant_text($message);
    $fields = array(
        'contextId' => $message['contextId'] ?? null,
        'from' => $from,
        'messageId' => $message['messageId'] ?? null,
        'text' => $text,
        'timestamp' => $timestamp,
        'to' => $to,
    );
    if ($public === null || $sig === false || strlen($sig) !== 64
        || base64_encode($sig) !== $sig64
        || !sodium_crypto_sign_verify_detached($sig, mae_restaurant_json($fields), $public)) {
        mae_restaurant_error($id, -32001, 'Signature verification failed');
    }
    $replay = 'mae_restaurant_replay_' . hash('sha256', (string) $message['messageId']);
    if (get_transient($replay)) {
        mae_restaurant_error($id, -32002, 'Duplicate messageId');
    }
    set_transient($replay, 1, 600);

    $booking = wp_json_encode(array(
        'type' => 'restaurant_reservation_request',
        'customer_did' => $from,
        'request' => $text,
        'status' => 'pending_restaurant_confirmation',
    ), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    $identity = mae_restaurant_identity();
    $reply_fields = array(
        'contextId' => $message['contextId'] ?? null,
        'from' => $card['did'],
        'messageId' => bin2hex(random_bytes(16)),
        'text' => $booking,
        'timestamp' => time(),
        'to' => $from,
    );
    $reply_sig = sodium_crypto_sign_detached(mae_restaurant_json($reply_fields), $identity['secret']);
    mae_restaurant_send(200, array(
        'jsonrpc' => '2.0',
        'id' => $id,
        'result' => array(
            'kind' => 'message',
            'role' => 'agent',
            'messageId' => $reply_fields['messageId'],
            'contextId' => $reply_fields['contextId'],
            'parts' => array(array('kind' => 'text', 'text' => $booking)),
            'metadata' => array(
                'timestamp' => $reply_fields['timestamp'],
                'from' => $card['did'],
                'to' => $from,
                'sig' => base64_encode($reply_sig),
                'replyTo' => $message['messageId'],
            ),
        ),
    ));
}

add_action('parse_request', function () {
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method === 'GET' && ($path === MAE_RESTAURANT_CARD || $path === MAE_RESTAURANT_CARD_LEGACY)) {
        mae_restaurant_send(200, mae_restaurant_card());
    }
    if ($method === 'GET' && $path === MAE_RESTAURANT_SIG) {
        $cached = get_transient('mae_restaurant_signed_card');
        if (!is_array($cached)) {
            $card = mae_restaurant_card();
            $identity = mae_restaurant_identity();
            $cached = array('v' => 1, 'typ' => 'agentcard', 'card' => $card, 'ts' => time());
            $cached['sig'] = base64_encode(sodium_crypto_sign_detached(
                mae_restaurant_json(array(
                    'card' => $card, 'ts' => $cached['ts'], 'typ' => 'agentcard', 'v' => 1,
                )),
                $identity['secret']
            ));
            set_transient('mae_restaurant_signed_card', $cached, 3600);
        }
        mae_restaurant_send(200, $cached);
    }
    if ($method === 'POST' && $path === '/' && empty($_SERVER['QUERY_STRING'])) {
        mae_restaurant_handle_post();
    }
});
