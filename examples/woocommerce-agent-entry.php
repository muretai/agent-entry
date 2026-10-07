<?php
/**
 * Plugin Name: WooCommerce Agent Entry
 * Description: One-file signed agent door for a WooCommerce shop: serves the shop's Agent Card and its signature.
 * Version: 1.0.0
 * Requires Plugins: woocommerce
 * License: MIT
 *
 * Install this file as wp-content/plugins/woocommerce-agent-entry/woocommerce-agent-entry.php,
 * keep PHP sodium enabled, put the shop's agent-entry.json text in the option
 * `muretai_agent_entry_declaration`, and activate. Activation mints the door's Ed25519 seed
 * once and keeps it on every later activation; a request never mints one. Until a seed and a
 * valid declaration both exist the plugin answers nothing and WordPress keeps every path.
 *
 * The card, its legacy path and the signature envelope are byte for byte what the Node door
 * (createAgentEntry({seedHex, name, baseUrl, declaration})) serves for the same declaration,
 * seed and second. The card names agent-tools.json because the Node door's card does; serving
 * that contract, ask and hold are later steps of this plugin.
 */

if (!defined('ABSPATH')) {
    exit;
}

const MAE_WOO_DECLARATION_OPTION = 'muretai_agent_entry_declaration';
const MAE_WOO_SEED_OPTION = 'muretai_agent_entry_seed';
const MAE_WOO_SIG_TRANSIENT = 'muretai_agent_entry_card_sig';
const MAE_WOO_CARD = '/.well-known/agent-card.json';
const MAE_WOO_CARD_LEGACY = '/.well-known/agent.json';
const MAE_WOO_SIG = '/.well-known/agent-card.sig.json';
const MAE_WOO_TOOLS = '/.well-known/agent-tools.json';
const MAE_WOO_TOOLS_EVENTS = '/.well-known/agent-tools/events';
const MAE_WOO_SIG_REFRESH_S = 3600;
const MAE_WOO_SCHEME = 'did-key-ed25519';

// ---------------------------------------------------------------- JSON, as the Node door writes it

/** One JSON string, spelled as JSON.stringify spells it: '/' and non-ASCII literal. */
function mae_woo_json_string($s) {
    $json = json_encode((string) $s, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS);
    if ($json === false) {
        throw new RuntimeException('a string is not encodable UTF-8');
    }
    return $json;
}

/**
 * JSON text. $sorted false is JSON.stringify (keys in insertion order, the card's bytes);
 * $sorted true is canonicalJSON (keys by code point, the signed bytes). A PHP list is a JSON
 * array; a stdClass or a keyed array is a JSON object.
 */
function mae_woo_json($value, $sorted = false) {
    if ($value === null) {
        return 'null';
    }
    if (is_bool($value)) {
        return $value ? 'true' : 'false';
    }
    if (is_int($value)) {
        if (abs($value) > 9007199254740991) {
            throw new RuntimeException('an integer is outside +/-(2**53-1)');
        }
        return (string) $value;
    }
    if (is_string($value)) {
        return mae_woo_json_string($value);
    }
    if (is_array($value) && ($value === array() || array_keys($value) === range(0, count($value) - 1))) {
        $parts = array();
        foreach ($value as $item) {
            $parts[] = mae_woo_json($item, $sorted);
        }
        return '[' . implode(',', $parts) . ']';
    }
    if (is_array($value) || $value instanceof stdClass) {
        $map = is_array($value) ? $value : get_object_vars($value);
        $keys = array_map('strval', array_keys($map));
        if ($sorted) {
            usort($keys, 'strcmp');   // UTF-8 byte order is code point order
        }
        $parts = array();
        foreach ($keys as $key) {
            $parts[] = mae_woo_json_string($key) . ':' . mae_woo_json($map[$key], $sorted);
        }
        return '{' . implode(',', $parts) . '}';
    }
    throw new RuntimeException('a value has no JSON spelling this door signs');
}

// ---------------------------------------------------------------- identity

function mae_woo_b58_encode($raw) {
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

/** The persisted seed, or null. Reading only: a request never mints one. */
function mae_woo_seed() {
    $seed = base64_decode((string) get_option(MAE_WOO_SEED_OPTION, ''), true);
    return ($seed !== false && strlen($seed) === 32) ? $seed : null;
}

function mae_woo_identity($seed) {
    $pair = sodium_crypto_sign_seed_keypair($seed);
    return array(
        'secret' => sodium_crypto_sign_secretkey($pair),
        'did' => 'did:key:z' . mae_woo_b58_encode("\xed\x01" . sodium_crypto_sign_publickey($pair)),
    );
}

/** Activation, and only activation, mints the seed. One already there is kept, so
 *  re-activating never changes the door's did. Stored base64, autoload off. */
function mae_woo_activate() {
    if (!function_exists('sodium_crypto_sign_seed_keypair')) {
        wp_die('WooCommerce Agent Entry needs the PHP sodium extension.');
    }
    $existing = get_option(MAE_WOO_SEED_OPTION, null);
    if ($existing !== null && $existing !== false) {
        if (mae_woo_seed() === null) {
            wp_die('WooCommerce Agent Entry: the option ' . MAE_WOO_SEED_OPTION . ' holds something that '
                . 'is not a seed. It was left as it is: replacing it would give this shop a new identity.');
        }
        return;
    }
    add_option(MAE_WOO_SEED_OPTION, base64_encode(random_bytes(32)), '', 'no');
}

register_activation_hook(__FILE__, 'mae_woo_activate');

// ---------------------------------------------------------------- the declaration (agent-entry.json)
//
// Read the way the Node door reads it, refusal for refusal, so a declaration the Node door
// would refuse to start on is not published here either. Anything refused serves nothing.

function mae_woo_refuse($field, $why) {
    throw new RuntimeException("agent-entry.json: $field $why");
}

function mae_woo_has($obj, $key) {
    return $obj instanceof stdClass && property_exists($obj, $key);
}

function mae_woo_only_keys($obj, $allowed, $field) {
    foreach (array_keys(get_object_vars($obj)) as $key) {
        if (!in_array((string) $key, $allowed, true)) {
            mae_woo_refuse($field, 'has an unexpected key');
        }
    }
}

function mae_woo_declared_string($value, $field) {
    if (!is_string($value) || $value === '') {
        mae_woo_refuse($field, 'must be a non-empty string');
    }
    return $value;
}

function mae_woo_same_origin_path($value, $field) {
    if (!is_string($value) || !preg_match('#^/(?![/\\\\])[\x21-\x7e]*$#D', $value) || strpos($value, '\\') !== false) {
        mae_woo_refuse($field, 'must be a same-origin path');
    }
    return $value;
}

function mae_woo_placeholders_name_input($template, $input, $field) {
    preg_match_all('/\{([^{}]*)\}/', $template, $m);
    foreach ($m[1] as $key) {
        if (!array_key_exists($key, $input)) {
            mae_woo_refuse($field, 'names a placeholder that is not in the offer\'s input');
        }
    }
}

/** canonicalBaseUrl: the one string the card publishes as its url. */
function mae_woo_canonical_base_url($given) {
    if (!is_string($given)) {
        mae_woo_refuse('entry.baseUrl', 'must be the URL visitors dial');
    }
    $s = trim($given, " \t\n\r\f\v");
    if ($s === '' || preg_match('/[^\x21-\x7e]/', $s) || strpbrk($s, '\\?#') !== false) {
        mae_woo_refuse('entry.baseUrl', 'is not usable');
    }
    $sep = strpos($s, '://');
    $scheme = $sep === false ? '' : strtolower(substr($s, 0, $sep));
    $default_ports = array('http' => 80, 'https' => 443);
    if (!isset($default_ports[$scheme])) {
        mae_woo_refuse('entry.baseUrl', 'is not an http(s) URL');
    }
    $rest = substr($s, $sep + 3);
    $cut = strpos($rest, '/');
    $authority = $cut === false ? $rest : substr($rest, 0, $cut);
    $path = $cut === false ? '' : substr($rest, $cut);
    if (strpbrk($authority, '@%') !== false) {
        mae_woo_refuse('entry.baseUrl', 'carries userinfo or a percent-escape in the host');
    }
    if (substr($authority, 0, 1) === '[') {
        $close = strpos($authority, ']');
        if ($close === false) {
            mae_woo_refuse('entry.baseUrl', 'has an unclosed IPv6 host');
        }
        $host = strtolower(substr($authority, 0, $close + 1));
        $tail = substr($authority, $close + 1);
        if ($tail !== '' && $tail[0] !== ':') {
            mae_woo_refuse('entry.baseUrl', 'has text after the IPv6 host');
        }
        $port_s = $tail === '' ? '' : substr($tail, 1);
    } else {
        $colon = strrpos($authority, ':');
        $host = strtolower($colon === false ? $authority : substr($authority, 0, $colon));
        $port_s = $colon === false ? '' : substr($authority, $colon + 1);
    }
    $port = null;
    if ($port_s !== '') {
        if (!ctype_digit($port_s) || (int) $port_s < 1 || (int) $port_s > 65535) {
            mae_woo_refuse('entry.baseUrl', 'has a port outside 1-65535');
        }
        $port = (int) $port_s;
    }
    $host = rtrim($host, '.');
    if ($host === '' || ($host[0] !== '[' && preg_match('/[^a-z0-9._-]/', $host))) {
        mae_woo_refuse('entry.baseUrl', 'has no usable host');
    }
    $path = rtrim($path, '/');
    if ($path !== '') {
        if (!preg_match('#^(?:[A-Za-z0-9\-._~!$&\'()*+,;=:@/]|%[0-9A-Fa-f]{2})*$#D', $path)) {
            mae_woo_refuse('entry.baseUrl', 'has a path character that must be percent-encoded');
        }
        foreach (explode('/', $path) as $segment) {
            $decoded = str_replace(array('%2e', '%2E'), '.', $segment);
            if ($decoded === '.' || $decoded === '..') {
                mae_woo_refuse('entry.baseUrl', 'has a dot segment in its path');
            }
        }
    }
    $origin = $scheme . '://' . $host . ($port !== null && $port !== $default_ports[$scheme] ? ':' . $port : '');
    return $origin . $path;
}

function mae_woo_valid_bare_domain($domain) {
    if ($domain === '' || strlen($domain) > 259 || strpbrk($domain, "/?#@\\ \t\r\n%[]") !== false
        || preg_match('/[\x80-\xff]/', $domain)) {
        return false;
    }
    $host = $domain;
    $colon = strpos($domain, ':');
    if ($colon !== false) {
        $host = substr($domain, 0, $colon);
        $port_s = substr($domain, $colon + 1);
        if (!ctype_digit($port_s) || (strlen($port_s) > 1 && $port_s[0] === '0')
            || (int) $port_s < 1 || (int) $port_s > 65535) {
            return false;
        }
    }
    if ($host === '' || strlen($host) > 253 || substr($host, -1) === '.') {
        return false;
    }
    $labels = explode('.', $host);
    if (count($labels) < 2) {
        return false;
    }
    foreach ($labels as $label) {
        if (!preg_match('/^[a-z0-9-]{1,63}$/D', $label) || $label[0] === '-' || substr($label, -1) === '-') {
            return false;
        }
    }
    return true;
}

/** entry.prefer, validated and never rewritten (it goes on the signed card as given). */
function mae_woo_prefer($entry) {
    if (!mae_woo_has($entry, 'prefer') || $entry->prefer === null) {
        return null;
    }
    $prefer = $entry->prefer;
    $kinds = array('page', 'card', 'mcp');
    $when = array('person', 'alone', 'key', 'no-key', 'token', 'browser');
    if (!is_array($prefer) || count($prefer) === 0) {
        mae_woo_refuse('entry.prefer', 'must be a non-empty list');
    }
    foreach ($prefer as $e) {
        if (is_string($e)) {
            if (!in_array($e, $kinds, true)) {
                mae_woo_refuse('entry.prefer', 'names an unknown kind');
            }
            continue;
        }
        if (!$e instanceof stdClass || !mae_woo_has($e, 'kind') || !in_array($e->kind, $kinds, true)) {
            mae_woo_refuse('entry.prefer', 'has an entry that is not a kind or {kind, when}');
        }
        if (mae_woo_has($e, 'when') && !in_array($e->when, $when, true)) {
            mae_woo_refuse('entry.prefer', 'names an unknown condition');
        }
        mae_woo_only_keys($e, array('kind', 'when'), 'entry.prefer');
    }
    return $prefer;
}

function mae_woo_page_action($action, $value, $input, $field) {
    switch ($action) {
        case 'open':
            mae_woo_same_origin_path($value, "$field.open");
            mae_woo_placeholders_name_input($value, $input, "$field.open");
            return;
        case 'read':
            mae_woo_declared_string($value, "$field.read");
            return;
        case 'call':
            if (!is_string($value) || !preg_match('/^[A-Za-z_$][A-Za-z0-9_$]*$/D', $value)) {
                mae_woo_refuse("$field.call", 'must be the name of a function the page registers');
            }
            return;
        case 'fill':
            if (!$value instanceof stdClass) {
                mae_woo_refuse("$field.fill", 'must be {form: "<selector>"}');
            }
            mae_woo_only_keys($value, array('form'), "$field.fill");
            mae_woo_declared_string($value->form ?? null, "$field.fill.form");
            return;
        case 'fetch':
            if (!$value instanceof stdClass) {
                mae_woo_refuse("$field.fetch", 'must be {method, path, query?}');
            }
            mae_woo_only_keys($value, array('method', 'path', 'query'), "$field.fetch");
            if (!in_array($value->method ?? null, array('GET', 'POST'), true)) {
                mae_woo_refuse("$field.fetch.method", 'must be "GET" or "POST"');
            }
            mae_woo_same_origin_path($value->path ?? null, "$field.fetch.path");
            if (mae_woo_has($value, 'query')) {
                if (!$value->query instanceof stdClass) {
                    mae_woo_refuse("$field.fetch.query", 'must map a query parameter to an input field');
                }
                foreach (get_object_vars($value->query) as $param => $from) {
                    mae_woo_declared_string((string) $param, "$field.fetch.query");
                    if (!is_string($from) || !array_key_exists($from, $input)) {
                        mae_woo_refuse("$field.fetch.query", 'must map each parameter to a field of the offer\'s input');
                    }
                }
            }
            return;
    }
    mae_woo_refuse($field, 'must be one of open, read, fill, fetch, call');
}

/** One offer, validated; returns what the card's skill is made of. */
function mae_woo_offer($offer, $i, $has_facts) {
    $at = "offers[$i]";
    $effects = array('find' => 'none', 'ask' => 'none', 'quote' => 'none', 'book' => 'changes', 'hold' => 'changes',
        'order' => 'changes', 'buy' => 'pays', 'track' => 'none', 'change' => 'changes', 'cancel' => 'reversible',
        'join' => 'changes');
    $floors = array('none' => 'never', 'reversible' => 'advised', 'changes' => 'advised', 'pays' => 'always');
    $effect_order = array('none', 'reversible', 'changes', 'pays');
    $ask_order = array('never', 'advised', 'always');
    if (!$offer instanceof stdClass) {
        mae_woo_refuse($at, 'must be an object');
    }
    mae_woo_only_keys($offer, array('verb', 'of', 'about', 'input', 'effect', 'ask', 'then', 'page', 'door'), $at);
    foreach (array('verb', 'of') as $key) {
        if (!is_string($offer->$key ?? null) || !preg_match('/^[a-z][a-z0-9_]*$/D', $offer->$key)) {
            mae_woo_refuse("$at.$key", 'must be lowercase ASCII letters, digits and "_", starting with a letter');
        }
    }
    $verb = $offer->verb;
    $about = mae_woo_declared_string($offer->about ?? null, "$at.about");
    if (!($offer->input ?? null) instanceof stdClass) {
        mae_woo_refuse("$at.input", 'must be a field map');
    }
    $input = array();
    foreach (get_object_vars($offer->input) as $key => $type) {
        $key = (string) $key;
        if (!preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/D', $key)
            || !in_array($type, array('string', 'integer', 'number', 'boolean'), true)) {
            mae_woo_refuse("$at.input", 'must map ASCII identifiers to string, integer, number or boolean');
        }
        $input[$key] = $type;
    }

    $default_effect = $effects[$verb] ?? null;
    if (mae_woo_has($offer, 'effect')) {
        if (!in_array($offer->effect, $effect_order, true)
            || ($default_effect !== null
                && array_search($offer->effect, $effect_order, true) < array_search($default_effect, $effect_order, true))) {
            mae_woo_refuse("$at.effect", 'is unknown or lowers the verb\'s default');
        }
    }
    $effect = mae_woo_has($offer, 'effect') ? $offer->effect : $default_effect;
    $floor = $effect === null ? null : $floors[$effect];
    if (mae_woo_has($offer, 'ask')) {
        if (!in_array($offer->ask, $ask_order, true)
            || ($floor !== null && array_search($offer->ask, $ask_order, true) < array_search($floor, $ask_order, true))) {
            mae_woo_refuse("$at.ask", 'is unknown or lowers the effect\'s floor');
        }
    }
    if (mae_woo_has($offer, 'then') && $offer->then !== 'door' && $offer->then !== 'none') {
        mae_woo_refuse("$at.then", 'must be "door" or "none"');
    }

    $bound = false;
    if (mae_woo_has($offer, 'page')) {
        $page = $offer->page;
        if (!$page instanceof stdClass) {
            mae_woo_refuse("$at.page", 'must be {on, do, then?}');
        }
        mae_woo_only_keys($page, array('on', 'do', 'then'), "$at.page");
        if (!is_array($page->on ?? null) || count($page->on) === 0) {
            mae_woo_refuse("$at.page.on", 'must be a non-empty list of route patterns');
        }
        foreach ($page->on as $pattern) {
            mae_woo_same_origin_path($pattern, "$at.page.on");
        }
        $do = ($page->do ?? null) instanceof stdClass ? get_object_vars($page->do) : null;
        $actions = array('open', 'read', 'fill', 'fetch', 'call');
        if ($do === null || count($do) !== 1 || !in_array((string) array_keys($do)[0], $actions, true)) {
            mae_woo_refuse("$at.page.do", 'must hold exactly one of open, read, fill, fetch, call');
        }
        if (mae_woo_has($page, 'then') && $page->then !== 'door') {
            mae_woo_refuse("$at.page.then", 'may only be "door"');
        }
        if (mae_woo_has($page, 'then') && mae_woo_has($offer, 'then') && $offer->then === 'none') {
            mae_woo_refuse("$at.then", 'is "none" while page.then is "door"');
        }
        $action = (string) array_keys($do)[0];
        mae_woo_page_action($action, $do[$action], $input, "$at.page.do");
        $bound = true;
    }
    if (mae_woo_has($offer, 'door')) {
        $door = $offer->door;
        if (!$door instanceof stdClass) {
            mae_woo_refuse("$at.door", 'must be {reply, receipt?, url?}');
        }
        mae_woo_only_keys($door, array('reply', 'receipt', 'url'), "$at.door");
        $reply = $door->reply ?? null;
        if (!in_array($reply, array('catalog', 'facts', 'pending', 'checkout', 'brain', 'human'), true)) {
            mae_woo_refuse("$at.door.reply", 'is not a reply kind');
        }
        if (mae_woo_has($door, 'receipt') && !is_bool($door->receipt)) {
            mae_woo_refuse("$at.door.receipt", 'must be true or false');
        }
        if ($reply === 'facts' && !$has_facts) {
            mae_woo_refuse("$at.door.reply", 'is "facts" but the declaration has no facts');
        }
        if ($reply === 'checkout') {
            if (!mae_woo_has($door, 'url')) {
                mae_woo_refuse("$at.door.url", 'is required for a checkout reply');
            }
            mae_woo_same_origin_path($door->url, "$at.door.url");
            mae_woo_placeholders_name_input($door->url, $input, "$at.door.url");
        } elseif (mae_woo_has($door, 'url')) {
            mae_woo_refuse("$at.door.url", 'belongs to a checkout reply only');
        }
        $bound = true;
    }
    if (!$bound) {
        mae_woo_refuse($at, 'binds neither a page nor a door, so nothing can do it');
    }
    return array('id' => $verb . '_' . $offer->of, 'verb' => $verb, 'of' => $offer->of, 'about' => $about, 'input' => $input);
}

/** The declaration in the option, read and validated; throws on anything the Node door refuses. */
function mae_woo_declaration() {
    $text = get_option(MAE_WOO_DECLARATION_OPTION, '');
    $d = is_string($text) ? json_decode($text, false, 512, JSON_BIGINT_AS_STRING) : null;
    if (!$d instanceof stdClass) {
        mae_woo_refuse('declaration', 'must be an object: {v, entry, offers, facts?}');
    }
    mae_woo_only_keys($d, array('v', 'entry', 'offers', 'facts', 'facts_source'), 'declaration');
    if (($d->v ?? null) !== 1 && ($d->v ?? null) !== 1.0) {   // JSON.parse reads 1.0 as 1
        mae_woo_refuse('v', 'must be 1');
    }
    $entry = $d->entry ?? null;
    if (!$entry instanceof stdClass) {
        mae_woo_refuse('entry', 'must be an object');
    }
    mae_woo_only_keys($entry, array('name', 'baseUrl', 'domains', 'prefer', 'catalog', 'counts', 'claim'), 'entry');
    $name = mae_woo_declared_string($entry->name ?? null, 'entry.name');
    $base = mae_woo_canonical_base_url($entry->baseUrl ?? null);
    if (mae_woo_has($entry, 'domains')) {
        if (!is_array($entry->domains)) {
            mae_woo_refuse('entry.domains', 'must be a list of bare domain names');
        }
        $seen = array();
        foreach ($entry->domains as $domain) {
            $lowered = is_string($domain) ? strtolower(trim($domain, " \t\n\r\f\v")) : '';
            if (!mae_woo_valid_bare_domain($lowered)) {
                mae_woo_refuse('entry.domains', 'is not a list of bare domain names');
            }
            $seen[$lowered] = true;
        }
        if (count($seen) > 5) {
            mae_woo_refuse('entry.domains', 'names more than the 5 a card may advertise');
        }
    }
    $prefer = mae_woo_prefer($entry);
    if (mae_woo_has($entry, 'catalog') && !is_bool($entry->catalog)) {
        mae_woo_refuse('entry.catalog', 'must be true or false');
    }
    if (mae_woo_has($entry, 'counts')) {
        $counts = $entry->counts;
        if (!is_string($counts) || !preg_match('#^https://[^/\\\\?\#]#i', $counts) || !wp_parse_url($counts, PHP_URL_HOST)) {
            mae_woo_refuse('entry.counts', 'must be an absolute https URL');
        }
    }
    if (mae_woo_has($entry, 'claim') && (!is_string($entry->claim) || !preg_match('/^[0-9a-f]{32}$/D', $entry->claim))) {
        mae_woo_refuse('entry.claim', 'must be the Catalog\'s claim code: exactly 32 lowercase hex characters');
    }
    $has_facts = mae_woo_has($d, 'facts');
    if ($has_facts) {
        if (!$d->facts instanceof stdClass) {
            mae_woo_refuse('facts', 'must map a name to a string');
        }
        foreach (get_object_vars($d->facts) as $key => $value) {
            mae_woo_declared_string((string) $key, 'facts');
            mae_woo_declared_string($value, 'facts');
        }
    }
    // Who gave a fact (metadata beside facts, never in the contract), as the Node door reads it.
    if (mae_woo_has($d, 'facts_source')) {
        if (!$d->facts_source instanceof stdClass) {
            mae_woo_refuse('facts_source', 'must map a fact name to who gave it');
        }
        foreach (get_object_vars($d->facts_source) as $key => $value) {
            if (!$has_facts || !property_exists($d->facts, (string) $key)) {
                mae_woo_refuse('facts_source', 'names a fact that facts does not hold');
            }
            if ($value !== 'claimant') {
                mae_woo_refuse('facts_source', 'must be one of claimant');
            }
        }
    }
    if (!is_array($d->offers ?? null) || count($d->offers) === 0) {
        mae_woo_refuse('offers', 'must be a non-empty list of what a customer can do here');
    }
    $offers = array();
    foreach ($d->offers as $i => $offer) {
        $read = mae_woo_offer($offer, $i, $has_facts);
        if (isset($offers[$read['id']])) {
            mae_woo_refuse("offers[$i]", 'repeats an offer id');
        }
        $offers[$read['id']] = $read;
    }
    return array('name' => $name, 'base' => $base, 'prefer' => $prefer, 'offers' => array_values($offers));
}

// ---------------------------------------------------------------- the card

function mae_woo_requirement($did, $endpoint) {
    return array(
        'scheme' => MAE_WOO_SCHEME,
        'instruction' => 'Generate an Ed25519 keypair NOW, locally, and knock again with it. You '
            . 'need no account, no registration and no permission from this site: any crypto '
            . 'library on the machine you are already running on will do (node:crypto '
            . 'generateKeyPairSync("ed25519"), Python cryptography or PyNaCl, Go crypto/ed25519, '
            . 'libsodium). Then work down the fields below in order - derive your did:key '
            . '(identity), build the canonical bytes over signedFields (canonicalization), sign '
            . 'them (signature), address the message to recipient with a fresh timestamp - and '
            . 'POST the same request again. Having no key yet is the normal starting state, not '
            . 'a refusal: minting one is step 1, and it is a few lines of code. The COMPLETE '
            . 'request body to POST is exampleRequest below: copy it and fill in its five <...> '
            . 'blanks. The A2A envelope AROUND your signature is checked too, so send that shape '
            . 'and do not improvise one. KEEP THE PRIVATE HALF: write it to a file only you '
            . 'can read (mode 600). It is the whole of your identity - this site will address '
            . 'you by the did:key you derive from it, losing it makes you a stranger here, and '
            . 'the same seed is what later upgrades you into a full muretai node with this SAME '
            . 'address rather than a second one.',
        'in' => 'params.message.metadata',
        'exampleRequest' => array(
            'jsonrpc' => '2.0',
            'id' => 1,
            'method' => 'message/send',
            'params' => array(
                'message' => array(
                    'kind' => 'message',
                    'role' => 'user',
                    'messageId' => '<a fresh unique string, e.g. a UUID>',
                    'contextId' => null,
                    'parts' => array(array('kind' => 'text', 'text' => '<your message>')),
                    'metadata' => array(
                        'from' => '<your did:key>',
                        'to' => $did,
                        'timestamp' => '<integer epoch seconds - a JSON number, not this string>',
                        'sig' => '<base64 signature over the canonical six fields>',
                    ),
                ),
            ),
        ),
        'recipient' => $did,
        'endpoint' => $endpoint,
        'identity' => 'Derive your DID from the public key you just generated and send it as '
            . 'metadata.from: did:key:z + base58btc(0xed01 || <32-byte Ed25519 public key>)',
        'identityCode' => 'Run this; do not encode base58btc by hand. node, no packages, `pub` = the '
            . '32 raw public-key bytes: '
            . "const A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; "
            . 'let n=0n; for (const b of Buffer.concat([Buffer.from([0xed,0x01]),pub])) '
            . 'n=n*256n+BigInt(b); '
            . "let s=''; while (n>0n) { s=A[Number(n%58n)]+s; n/=58n; } "
            . "const did='did:key:z'+s;   // 0xed leads, so no leading-zero '1' case can arise",
        'signedFields' => array('contextId', 'from', 'messageId', 'text', 'timestamp', 'to'),
        'canonicalization' => 'Build the bytes to sign as a JSON object of exactly those six '
            . 'fields, keys sorted by Unicode code point, separators "," and ":", no whitespace, '
            . 'non-ASCII literal, UTF-8. When you have no conversation yet, contextId is JSON '
            . 'null - it is still one of the six and is still signed, so never omit it (see '
            . 'exampleRequest, which already has it right)',
        'signature' => 'Sign those bytes with your private key and set metadata.sig = base64 '
            . '(standard alphabet, padded) of the 64-byte Ed25519 signature over those bytes',
        'timestamp' => 'Set metadata.timestamp = integer epoch seconds, within 300 s of this '
            . 'entry\'s clock',
    );
}

/** The card, field for field and in the Node door's order. */
function mae_woo_card($declaration, $did) {
    $base = $declaration['base'];
    $mount = (string) wp_parse_url($base, PHP_URL_PATH);
    $door_url = $base . ($mount === '' ? '/' : '');
    $requirement = mae_woo_requirement($did, $door_url);
    $skills = array();
    foreach ($declaration['offers'] as $o) {
        $examples = array($o['about']);
        if ($o['input']) {
            $shape = array();
            foreach ($o['input'] as $key => $type) {
                $shape[$key] = '<' . $type . '>';
            }
            $examples[] = $o['verb'] . ' ' . $o['of'] . ' ' . mae_woo_json($shape, true);
        }
        $skills[] = array(
            'id' => $o['id'], 'name' => $o['id'], 'description' => $o['about'],
            'tags' => array($o['verb'], $o['of']), 'examples' => $examples,
        );
    }
    $agent_entry = array('open_door' => true);
    if ($declaration['prefer'] !== null) {
        $agent_entry['prefer'] = $declaration['prefer'];
    }
    $agent_entry['tools'] = $base . MAE_WOO_TOOLS;
    $agent_entry['events'] = $base . MAE_WOO_TOOLS_EVENTS;
    return array(
        'protocolVersion' => '0.2',
        'name' => $declaration['name'],
        'description' => 'Signed agent-to-agent messaging. Send an A2A message and get a signed reply.',
        'url' => $base,
        'did' => $did,
        'version' => '1',
        'capabilities' => array('streaming' => false, 'pushNotifications' => false),
        'defaultInputModes' => array('text/plain'),
        'defaultOutputModes' => array('text/plain'),
        'skills' => $skills,
        'agentEntry' => $agent_entry,
        'muretai' => array('open_door' => true),
        'securitySchemes' => array(MAE_WOO_SCHEME => array(
            'type' => MAE_WOO_SCHEME,
            'description' => 'Generate an Ed25519 keypair if you do not have one - no account, no '
                . 'registration, any crypto library will do - then sign every message/send with '
                . 'the did:key you present as metadata.from. The step-by-step instruction, the '
                . 'signed fields, the canonical bytes and the address to send to are in '
                . '`agentEntry` beside this line',
            'agentEntry' => $requirement,
            'muretai' => $requirement,
        )),
        'security' => array(array(MAE_WOO_SCHEME => array())),
        'supportedInterfaces' => array(array('url' => $door_url, 'protocolBinding' => 'JSONRPC', 'protocolVersion' => '0.2')),
    );
}

/** The signed envelope's bytes, re-minted at most hourly (a consumer rejects one older than
 *  6h) and whenever the card changes. Only ever called once a seed exists. */
function mae_woo_envelope_bytes($card, $card_bytes, $secret) {
    $now = time();
    $key = hash('sha256', $card_bytes);
    $cached = get_transient(MAE_WOO_SIG_TRANSIENT);
    if (is_array($cached) && ($cached['card'] ?? null) === $key && is_int($cached['ts'] ?? null)
        && $now >= $cached['ts'] && $now - $cached['ts'] < MAE_WOO_SIG_REFRESH_S && is_string($cached['body'] ?? null)) {
        return $cached['body'];
    }
    $payload = mae_woo_json(array('card' => $card, 'ts' => $now, 'typ' => 'agentcard', 'v' => 1), true);
    $body = mae_woo_json(array(
        'v' => 1,
        'typ' => 'agentcard',
        'card' => $card,
        'ts' => $now,
        'sig' => base64_encode(sodium_crypto_sign_detached($payload, $secret)),
    ));
    set_transient(MAE_WOO_SIG_TRANSIENT, array('card' => $key, 'ts' => $now, 'body' => $body), MAE_WOO_SIG_REFRESH_S);
    return $body;
}

/** Offer text in an HTML page: the characters, never a tag. Same spelling as escapeHtml. */
function mae_woo_escape_html($value) {
    return str_replace(
        array('&', '<', '>', '"', "'"),
        array('&#38;', '&#60;', '&#62;', '&#34;', '&#39;'),
        (string) $value
    );
}

/** The same block offersSignpost prints: every offer, the knock line, the head link and the card. */
function mae_woo_offers_signpost($declaration) {
    $base = $declaration['base'];
    $mount = rtrim((string) wp_parse_url($base, PHP_URL_PATH), '/');
    $card_path = $mount . '/.well-known/agent-card.json';
    $card_url = $base . '/.well-known/agent-card.json';
    $rel = 'https://muretai.net/rel/agent-entry';
    $lines = array(
        '<link rel="' . $rel . '" href="' . $card_path . '">',
        '<a href="' . $card_path . '" rel="' . $rel . '">This site answers agents at ' . $card_path . '</a>',
        $card_url,
    );
    foreach ($declaration['offers'] as $offer) {
        $lines[] = mae_woo_escape_html($offer['verb']) . ' ' . mae_woo_escape_html($offer['of']);
        $lines[] = mae_woo_escape_html($offer['about']);
        $names = array_keys($offer['input']);
        sort($names, SORT_STRING);
        foreach ($names as $name) {
            $lines[] = mae_woo_escape_html($name) . ' ' . mae_woo_escape_html($offer['input'][$name]);
        }
        $lines[] = "needs the customer's key";
        $lines[] = 'knock ' . $card_url . ' --offer ' . mae_woo_escape_html($offer['id']);
    }
    return implode("\n", $lines);
}

/** True when Accept lists text/html as its own media type. */
function mae_woo_accept_lists_html() {
    $raw = (string) ($_SERVER['HTTP_ACCEPT'] ?? '');
    if ($raw === '') {
        return false;
    }
    foreach (explode(',', $raw) as $part) {
        $media = strtolower(trim(explode(';', $part, 2)[0]));
        if ($media === 'text/html') {
            return true;
        }
    }
    return false;
}

function mae_woo_send($body, $head) {
    status_header(200);
    header('Content-Type: application/json; charset=utf-8');
    header('Content-Length: ' . strlen($body));
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Max-Age: 600');
    if (!$head) {
        echo $body;
    }
    exit;
}

add_action('parse_request', function () {
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method !== 'GET' && $method !== 'HEAD') {
        return;
    }
    $target = (string) ($_SERVER['REQUEST_URI'] ?? '/');
    $path = explode('#', explode('?', $target, 2)[0], 2)[0];
    if (substr($path, -strlen(MAE_WOO_CARD)) !== MAE_WOO_CARD
        && substr($path, -strlen(MAE_WOO_CARD_LEGACY)) !== MAE_WOO_CARD_LEGACY
        && substr($path, -strlen(MAE_WOO_SIG)) !== MAE_WOO_SIG) {
        return;   // not ours: no option is even read
    }
    if (!function_exists('sodium_crypto_sign_detached')) {
        return;
    }
    $seed = mae_woo_seed();
    if ($seed === null) {
        return;   // not activated: no seed, so no card and no signature
    }
    try {
        $declaration = mae_woo_declaration();
    } catch (RuntimeException $e) {
        return;   // a declaration the Node door would refuse is not published here either
    }
    $mount = (string) wp_parse_url($declaration['base'], PHP_URL_PATH);
    if ($path !== $mount . MAE_WOO_CARD && $path !== $mount . MAE_WOO_CARD_LEGACY && $path !== $mount . MAE_WOO_SIG) {
        return;
    }
    $identity = mae_woo_identity($seed);
    $card = mae_woo_card($declaration, $identity['did']);
    $card_bytes = mae_woo_json($card);
    if ($path === $mount . MAE_WOO_SIG) {
        mae_woo_send(mae_woo_envelope_bytes($card, $card_bytes, $identity['secret']), $method === 'HEAD');
    }
    mae_woo_send($card_bytes, $method === 'HEAD');
});

add_action('template_redirect', function () {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET' || !mae_woo_accept_lists_html()) {
        return;
    }
    $target = (string) ($_SERVER['REQUEST_URI'] ?? '/');
    $path = explode('#', explode('?', $target, 2)[0], 2)[0];
    if (substr($path, -strlen(MAE_WOO_CARD)) === MAE_WOO_CARD
        || substr($path, -strlen(MAE_WOO_CARD_LEGACY)) === MAE_WOO_CARD_LEGACY
        || substr($path, -strlen(MAE_WOO_SIG)) === MAE_WOO_SIG) {
        return;
    }
    try {
        $declaration = mae_woo_declaration();
    } catch (RuntimeException $e) {
        return;
    }
    echo mae_woo_offers_signpost($declaration);
});
