package kr.jayt.missa;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * 얇은 껍데기 앱. 화면과 미사 자료는 모두 GitHub Pages 주소의 웹앱이 맡는다.
 * 그래서 다음 달 자료를 웹에 올리면 앱을 다시 설치하지 않아도 바로 바뀐다.
 */
public class MainActivity extends Activity {

    private static final String BASE = "https://koreantch-stack.github.io/JayT/missa/";

    private WebView web;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(0xFF5A0A1A);
        getWindow().setNavigationBarColor(0xFFFFFDF6);

        web = new WebView(this);
        web.setBackgroundColor(0xFFFFFDF6);
        setContentView(web);

        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(false);
        ws.setSupportZoom(false);
        ws.setBuiltInZoomControls(false);
        ws.setTextZoom(100);
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (u.toString().startsWith(BASE)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (ActivityNotFoundException ignored) {
                    // 열 앱이 없으면 무시
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                String html = "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                        + "<body style='font-family:sans-serif;background:#fffdf6;color:#141414;padding:32px;text-align:center;line-height:1.7'>"
                        + "<h2 style='font-size:26px'>인터넷에 연결되어 있지 않습니다</h2>"
                        + "<p style='font-size:22px'>와이파이나 데이터를 켠 뒤<br>아래 버튼을 눌러 주세요.</p>"
                        + "<button style='font-size:24px;padding:16px 32px;border:0;border-radius:12px;background:#1f3a5f;color:#fff'"
                        + " onclick=\"location.href='" + BASE + "'\">다시 시도</button></body>";
                view.loadData(html, "text/html; charset=utf-8", null);
            }
        });

        web.loadUrl(BASE);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // 웹앱 안에서 한 단계 뒤로(날짜 → 달력 등), 더 갈 곳이 없으면 앱 종료
        if (web != null && web.canGoBack()) web.goBack();
        else finish();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
