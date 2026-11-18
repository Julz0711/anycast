package app.anycast.tv;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;

/**
 * AnyCast for Fire TV: a fullscreen WebView around the AnyCast web app, nothing more.
 * The Menu button (three lines) on the remote changes the server address.
 */
public class MainActivity extends Activity {
    static final String DEFAULT_URL = "https://anycast.gtkncht.com";
    static final String LAN_URL = "http://192.168.0.232:8787";

    private FrameLayout root;
    private WebView web;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private AlertDialog dialog;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(14, 15, 17));
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(14, 15, 17));
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        hideSystemUi();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        // lets the web app tell it runs on the TV
        s.setUserAgentString(s.getUserAgentString() + " AnyCastTV/1");
        CookieManager.getInstance().setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= 21) CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, int code, String description, String failingUrl) {
                showError(description);
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreenView != null) { callback.onCustomViewHidden(); return; }
                fullscreenView = view;
                fullscreenCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(-1, -1));
                web.setVisibility(View.GONE);
                hideSystemUi();
            }

            @Override
            public void onHideCustomView() {
                exitFullscreen();
            }
        });

        if (state != null) web.restoreState(state);
        else web.loadUrl(url());
        web.requestFocus();
    }

    private SharedPreferences prefs() {
        return getSharedPreferences("anycast", MODE_PRIVATE);
    }

    private String url() {
        return prefs().getString("url", DEFAULT_URL);
    }

    private void open(String u) {
        u = u.trim();
        if (u.isEmpty()) u = DEFAULT_URL;
        if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://" + u;
        prefs().edit().putString("url", u).apply();
        web.clearHistory();
        web.loadUrl(u);
    }

    private void showError(String description) {
        if (dialog != null && dialog.isShowing()) return;
        dialog = new AlertDialog.Builder(this)
                .setTitle("Can't reach AnyCast")
                .setMessage(url() + "\n\n" + description + "\n\nIs Tailscale on? Is the server running?")
                .setPositiveButton("Try again", (d, w) -> web.loadUrl(url()))
                .setNeutralButton("Home network", (d, w) -> open(LAN_URL))
                .setNegativeButton("Change address", (d, w) -> showAddress())
                .show();
    }

    private void showAddress() {
        if (dialog != null && dialog.isShowing()) dialog.dismiss();
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setText(url());
        input.setSelectAllOnFocus(true);
        dialog = new AlertDialog.Builder(this)
                .setTitle("AnyCast address")
                .setView(input)
                .setPositiveButton("Open", (d, w) -> open(input.getText().toString()))
                .setNeutralButton("Home network", (d, w) -> open(LAN_URL))
                .setNegativeButton("Default", (d, w) -> open(DEFAULT_URL))
                .show();
    }

    private void exitFullscreen() {
        if (fullscreenView == null) return;
        root.removeView(fullscreenView);
        fullscreenView = null;
        web.setVisibility(View.VISIBLE);
        if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
        fullscreenCallback = null;
        web.requestFocus();
    }

    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_MENU) {
            showAddress();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public void onBackPressed() {
        if (fullscreenView != null) exitFullscreen();
        else if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            ((ViewGroup) web.getParent()).removeView(web);
            web.destroy();
        }
        super.onDestroy();
    }
}
