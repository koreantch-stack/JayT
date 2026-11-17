package kr.jayt.pdfviewer;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;

/**
 * 얇은 껍데기 앱. 화면과 기능은 GitHub Pages 주소의 웹앱이 맡고,
 * 이 앱은 "PDF를 누르면 이 앱으로 열기"와 파일 전달만 담당한다.
 */
public class MainActivity extends Activity {

    private static final String BASE = "https://koreantch-stack.github.io/JayT/pdf-viewer/";
    private static final int REQ_PICK = 1;

    private WebView web;
    private boolean pageReady = false;
    private ValueCallback<Uri[]> chooserCb;

    // 웹앱에 넘겨줄 PDF (JavascriptInterface는 별도 스레드에서 불리므로 lock으로 보호)
    private final Object lock = new Object();
    private ParcelFileDescriptor pfd;
    private FileChannel channel;
    private String pdfName = "";
    private long pdfSize = 0;
    private OutputStream saveOut;
    private Uri saveUri;

    /** 저장 마무리. ok면 파일을 확정하고 이름을 돌려주고, 아니면 만들다 만 파일을 지운다. */
    private String closeSave(boolean ok) {
        String result = "";
        try { if (saveOut != null) saveOut.close(); } catch (IOException ignored) { }
        saveOut = null;
        if (saveUri != null) {
            try {
                if (ok) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.IS_PENDING, 0);
                    getContentResolver().update(saveUri, v, null, null);
                    Cursor c = getContentResolver().query(saveUri, new String[]{MediaStore.Downloads.DISPLAY_NAME}, null, null, null);
                    if (c != null) { if (c.moveToFirst()) result = c.getString(0); c.close(); }
                } else getContentResolver().delete(saveUri, null, null);
            } catch (Exception ignored) { }
            saveUri = null;
        }
        return result;
    }

    /** 웹앱에서 window.PdfNative 로 보이는 통로 */
    private class Bridge {
        /** 필기를 합친 PDF를 다운로드 폴더에 저장 (안드로이드 10 이상) */
        @JavascriptInterface
        public boolean saveStart(String name) {
            synchronized (lock) {
                closeSave(false);
                if (Build.VERSION.SDK_INT < 29) return false;
                try {
                    String n = name == null ? "문서.pdf" : name.replaceAll("[\\\\/:*?\"<>|]", "_");
                    if (!n.toLowerCase().endsWith(".pdf")) n += ".pdf";
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.Downloads.DISPLAY_NAME, n);
                    v.put(MediaStore.Downloads.MIME_TYPE, "application/pdf");
                    v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    v.put(MediaStore.Downloads.IS_PENDING, 1);
                    saveUri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (saveUri == null) return false;
                    saveOut = getContentResolver().openOutputStream(saveUri);
                    return saveOut != null;
                } catch (Exception e) {
                    closeSave(false);
                    return false;
                }
            }
        }

        @JavascriptInterface
        public boolean saveChunk(String b64) {
            synchronized (lock) {
                if (saveOut == null) return false;
                try {
                    saveOut.write(Base64.decode(b64, Base64.DEFAULT));
                    return true;
                } catch (Exception e) {
                    return false;
                }
            }
        }

        /** 성공하면 저장된 파일 이름, 실패하면 빈 문자열 */
        @JavascriptInterface
        public String saveEnd(boolean ok) {
            synchronized (lock) { return closeSave(ok); }
        }

        @JavascriptInterface
        public String name() {
            synchronized (lock) { return pdfName; }
        }

        @JavascriptInterface
        public long size() {
            synchronized (lock) { return pdfSize; }
        }

        @JavascriptInterface
        public String chunk(long offset, int length) {
            synchronized (lock) {
                if (channel == null || length <= 0) return "";
                try {
                    ByteBuffer buf = ByteBuffer.allocate(length);
                    channel.position(offset);
                    int total = 0;
                    while (total < length) {
                        int n = channel.read(buf);
                        if (n < 0) break;
                        total += n;
                    }
                    return Base64.encodeToString(buf.array(), 0, total, Base64.NO_WRAP);
                } catch (IOException e) {
                    return "";
                }
            }
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(0xFF1F2328);
        getWindow().setNavigationBarColor(0xFF1F2328);

        web = new WebView(this);
        web.setBackgroundColor(0xFF3B3E43);
        setContentView(web);

        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(false);
        ws.setSupportZoom(false);
        ws.setBuiltInZoomControls(false);
        ws.setTextZoom(100);

        web.addJavascriptInterface(new Bridge(), "PdfNative");

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
            public void onPageFinished(WebView view, String url) {
                pageReady = url != null && url.startsWith(BASE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                pageReady = false;
                String html = "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                        + "<body style='font-family:sans-serif;background:#3b3e43;color:#eee;padding:32px;text-align:center'>"
                        + "<h2>인터넷에 연결되어 있지 않습니다</h2>"
                        + "<p>처음 한 번은 인터넷이 필요합니다.<br>한 번 열어 본 뒤에는 인터넷 없이도 열립니다.</p>"
                        + "<button style='font-size:18px;padding:14px 28px;border:0;border-radius:12px;background:#ffcc33'"
                        + " onclick=\"location.href='" + BASE + "'\">다시 시도</button></body>";
                view.loadData(html, "text/html; charset=utf-8", null);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            // 웹앱의 "열기" 버튼 → 안드로이드 파일 선택 화면
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (chooserCb != null) chooserCb.onReceiveValue(null);
                chooserCb = callback;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("application/pdf");
                try {
                    startActivityForResult(i, REQ_PICK);
                } catch (Exception e) {
                    chooserCb = null;
                    callback.onReceiveValue(null);
                    return false;
                }
                return true;
            }
        });

        Uri pdf = pdfUriFrom(getIntent());
        boolean has = pdf != null && setPdf(pdf);
        web.loadUrl(has ? BASE + "?native=1" : BASE);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        Uri pdf = pdfUriFrom(intent);
        if (pdf == null) return;
        if (!setPdf(pdf)) {
            Toast.makeText(this, "파일을 열 수 없습니다", Toast.LENGTH_SHORT).show();
            return;
        }
        if (pageReady) web.evaluateJavascript("window.openNativePdf&&window.openNativePdf()", null);
        else web.loadUrl(BASE + "?native=1");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PICK) return;
        // 웹 쪽 파일 입력은 취소로 돌려 두고, 고른 파일은 앱이 직접 웹앱에 넘긴다
        if (chooserCb != null) {
            chooserCb.onReceiveValue(null);
            chooserCb = null;
        }
        Uri u = (resultCode == RESULT_OK && data != null) ? data.getData() : null;
        if (u != null && setPdf(u)) {
            web.evaluateJavascript("window.openNativePdf&&window.openNativePdf()", null);
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("(window.onNativeBack&&window.onNativeBack())?'1':'0'", value -> {
            if (!"\"1\"".equals(value)) finish();
        });
    }

    @Override
    protected void onDestroy() {
        synchronized (lock) { closePdf(); }
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    private Uri pdfUriFrom(Intent it) {
        if (it == null) return null;
        String action = it.getAction();
        if (Intent.ACTION_VIEW.equals(action)) return it.getData();
        if (Intent.ACTION_SEND.equals(action)) return (Uri) it.getParcelableExtra(Intent.EXTRA_STREAM);
        return null;
    }

    private boolean setPdf(Uri uri) {
        synchronized (lock) {
            closePdf();
            try {
                pfd = getContentResolver().openFileDescriptor(uri, "r");
                if (pfd == null) return false;
                channel = new ParcelFileDescriptor.AutoCloseInputStream(pfd).getChannel();
                long size = pfd.getStatSize();
                pdfSize = size >= 0 ? size : channel.size();
                pdfName = queryName(uri);
                return true;
            } catch (Exception e) {
                closePdf();
                return false;
            }
        }
    }

    private void closePdf() {
        try { if (channel != null) channel.close(); } catch (IOException ignored) { }
        try { if (pfd != null) pfd.close(); } catch (IOException ignored) { }
        channel = null;
        pfd = null;
        pdfSize = 0;
        pdfName = "";
    }

    private String queryName(Uri uri) {
        String name = null;
        if ("content".equals(uri.getScheme())) {
            try (Cursor c = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (c != null && c.moveToFirst()) name = c.getString(0);
            } catch (Exception ignored) {
                // 이름을 못 얻으면 아래 기본값 사용
            }
        }
        if (name == null || name.isEmpty()) name = uri.getLastPathSegment();
        if (name == null || name.isEmpty()) name = "문서.pdf";
        return name;
    }
}
