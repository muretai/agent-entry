<?php
// The smallest WordPress conformance/recipes.mjs runs examples/woocommerce-agent-entry.php under.
//
//   php -S 127.0.0.1:<port> wp-shim.php   one request: load the plugin, fire plugins_loaded, init,
//                                         parse_request, template_redirect; a request no hook
//                                         answered is WordPress's own page (404 here).
//   php wp-shim.php activate              load the plugin and run its register_activation_hook
//                                         callbacks, as WordPress does when the owner clicks Activate.
//
// Environment: MAE_SHIM_PLUGIN (the plugin file), MAE_SHIM_STATE (a JSON file of options and
// transients, each value base64(serialize(value)) so binary strings survive), MAE_SHIM_HOME
// (home_url). WooCommerce counts as active: class WooCommerce exists. Fixture only, never shipped.

define('ABSPATH', __DIR__ . '/');
define('WPINC', 'wp-includes');

class WooCommerce {}

$GLOBALS['mae_shim_hooks'] = array();
$GLOBALS['mae_shim_activation'] = array();

function mae_shim_state_path() {
    $path = getenv('MAE_SHIM_STATE');
    if (!$path) {
        fwrite(STDERR, "wp-shim: MAE_SHIM_STATE is not set\n");
        exit(2);
    }
    return $path;
}

function mae_shim_load() {
    $path = mae_shim_state_path();
    $state = is_file($path) ? json_decode(file_get_contents($path), true) : null;
    if (!is_array($state)) {
        $state = array();
    }
    $state += array('options' => array(), 'transients' => array());
    return $state;
}

function mae_shim_save($state) {
    if (!$state['options']) {
        $state['options'] = new stdClass();
    }
    if (!$state['transients']) {
        $state['transients'] = new stdClass();
    }
    file_put_contents(mae_shim_state_path(), json_encode($state, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT), LOCK_EX);
}

// ---------------------------------------------------------------- hooks

function add_action($hook, $callback, $priority = 10, $args = 1) {
    $GLOBALS['mae_shim_hooks'][$hook][$priority][] = array($callback, $args);
    return true;
}

function add_filter($hook, $callback, $priority = 10, $args = 1) {
    return add_action($hook, $callback, $priority, $args);
}

function has_action($hook) {
    return !empty($GLOBALS['mae_shim_hooks'][$hook]);
}

function do_action($hook, ...$args) {
    $byPriority = $GLOBALS['mae_shim_hooks'][$hook] ?? array();
    ksort($byPriority);
    foreach ($byPriority as $callbacks) {
        foreach ($callbacks as $entry) {
            call_user_func_array($entry[0], array_slice($args, 0, $entry[1]));
        }
    }
}

function apply_filters($hook, $value, ...$args) {
    $byPriority = $GLOBALS['mae_shim_hooks'][$hook] ?? array();
    ksort($byPriority);
    foreach ($byPriority as $callbacks) {
        foreach ($callbacks as $entry) {
            $value = call_user_func_array($entry[0], array_slice(array_merge(array($value), $args), 0, max(1, $entry[1])));
        }
    }
    return $value;
}

function register_activation_hook($file, $callback) {
    $GLOBALS['mae_shim_activation'][] = $callback;
}

function register_deactivation_hook($file, $callback) {
}

// ---------------------------------------------------------------- options and transients

function get_option($name, $default = false) {
    $state = mae_shim_load();
    if (!array_key_exists($name, $state['options'])) {
        return $default;
    }
    return unserialize(base64_decode($state['options'][$name]));
}

function update_option($name, $value, $autoload = null) {
    $state = mae_shim_load();
    $state['options'][$name] = base64_encode(serialize($value));
    mae_shim_save($state);
    return true;
}

function add_option($name, $value = '', $deprecated = '', $autoload = 'yes') {
    $state = mae_shim_load();
    if (array_key_exists($name, $state['options'])) {
        return false;
    }
    return update_option($name, $value);
}

function delete_option($name) {
    $state = mae_shim_load();
    $had = array_key_exists($name, $state['options']);
    unset($state['options'][$name]);
    mae_shim_save($state);
    return $had;
}

function get_transient($name) {
    $state = mae_shim_load();
    $row = $state['transients'][$name] ?? null;
    if (!is_array($row) || ($row['expires'] && $row['expires'] < time())) {
        return false;
    }
    return unserialize(base64_decode($row['value']));
}

function set_transient($name, $value, $ttl = 0) {
    $state = mae_shim_load();
    $state['transients'][$name] = array(
        'expires' => $ttl ? time() + (int) $ttl : 0,
        'value' => base64_encode(serialize($value)),
    );
    mae_shim_save($state);
    return true;
}

function delete_transient($name) {
    $state = mae_shim_load();
    unset($state['transients'][$name]);
    mae_shim_save($state);
    return true;
}

// ---------------------------------------------------------------- the rest of the surface a plugin touches

function home_url($path = '') {
    return rtrim((string) getenv('MAE_SHIM_HOME'), '/') . '/' . ltrim($path, '/');
}

function site_url($path = '') {
    return home_url($path);
}

function untrailingslashit($value) {
    return rtrim($value, '/\\');
}

function trailingslashit($value) {
    return untrailingslashit($value) . '/';
}

function get_bloginfo($show = '') {
    return $show === 'name' ? 'Shim Shop' : '';
}

function wp_json_encode($value, $flags = 0, $depth = 512) {
    return json_encode($value, $flags, $depth);
}

function wp_parse_url($url, $component = -1) {
    return parse_url($url, $component);
}

function wp_unslash($value) {
    return is_string($value) ? stripslashes($value) : $value;
}

function status_header($code) {
    http_response_code((int) $code);
}

function nocache_headers() {
    header('Cache-Control: no-cache, must-revalidate, max-age=0');
}

function is_ssl() {
    return false;
}

function is_admin() {
    return false;
}

function current_user_can($capability) {
    return false;
}

function plugin_dir_path($file) {
    return trailingslashit(dirname($file));
}

function plugin_basename($file) {
    return basename(dirname($file)) . '/' . basename($file);
}

function __($text, $domain = 'default') {
    return $text;
}

function esc_html($text) {
    return htmlspecialchars((string) $text, ENT_QUOTES, 'UTF-8');
}

function esc_attr($text) {
    return esc_html($text);
}

function esc_url($url) {
    return (string) $url;
}

function absint($value) {
    return abs((int) $value);
}

function sanitize_text_field($value) {
    return trim(strip_tags((string) $value));
}

function wp_die($message = '', $title = '', $args = array()) {
    $code = is_array($args) && isset($args['response']) ? (int) $args['response'] : 500;
    http_response_code($code);
    echo is_string($message) ? $message : '';
    exit;
}

// ---------------------------------------------------------------- run

$plugin = getenv('MAE_SHIM_PLUGIN');
if (!$plugin || !is_file($plugin)) {
    if (PHP_SAPI === 'cli-server') {
        http_response_code(500);
    }
    fwrite(STDERR, "wp-shim: MAE_SHIM_PLUGIN does not name a file\n");
    exit(2);
}
require $plugin;

if (PHP_SAPI === 'cli') {
    if (($argv[1] ?? '') !== 'activate') {
        fwrite(STDERR, "usage: php wp-shim.php activate\n");
        exit(2);
    }
    foreach ($GLOBALS['mae_shim_activation'] as $callback) {
        call_user_func($callback, false);
    }
    exit(0);
}

do_action('plugins_loaded');
do_action('init');
do_action('parse_request', new stdClass());
do_action('template_redirect');
http_response_code(404);
header('Content-Type: text/html; charset=utf-8');
echo 'wp-shim: the WordPress page (no plugin route answered)';
