package com.guowenchuang.keygen;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.widget.*;
import androidx.appcompat.app.AppCompatActivity;
import org.json.JSONArray;
import org.json.JSONObject;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class MainActivity extends AppCompatActivity {

    private EditText etRequestCode;
    private Button btnPaste;
    private LinearLayout layoutBadge;
    private TextView tvBadgeStatus;
    private TextView tvBadgeInfo;

    private Spinner spinnerDuration;
    private Spinner spinnerRuns;

    private Button btnGenerate;
    private LinearLayout layoutResult;
    private TextView tvLicenseCode;
    private Button btnCopyCode;
    private Button btnCopyTemplate;
    private Button btnCopyContact;

    private TextView tvClearHistory;
    private LinearLayout layoutHistoryList;

    private LicenseCore.RequestResult currentReqResult = null;
    private String lastGeneratedLicense = "";
    private String lastSelectedDurationLabel = "";

    private SharedPreferences sp;
    private static final String PREF_NAME = "KeygenHistory";
    private static final String KEY_HISTORY = "history_records";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        sp = getSharedPreferences(PREF_NAME, MODE_PRIVATE);

        initViews();
        initSpinners();
        initListeners();
        loadHistory();
    }

    private void initViews() {
        etRequestCode = findViewById(R.id.et_request_code);
        btnPaste = findViewById(R.id.btn_paste);
        layoutBadge = findViewById(R.id.layout_badge);
        tvBadgeStatus = findViewById(R.id.tv_badge_status);
        tvBadgeInfo = findViewById(R.id.tv_badge_info);

        spinnerDuration = findViewById(R.id.spinner_duration);
        spinnerRuns = findViewById(R.id.spinner_runs);

        btnGenerate = findViewById(R.id.btn_generate);
        layoutResult = findViewById(R.id.layout_result);
        tvLicenseCode = findViewById(R.id.tv_license_code);
        btnCopyCode = findViewById(R.id.btn_copy_code);
        btnCopyTemplate = findViewById(R.id.btn_copy_template);
        btnCopyContact = findViewById(R.id.btn_copy_contact);

        tvClearHistory = findViewById(R.id.tv_clear_history);
        layoutHistoryList = findViewById(R.id.layout_history_list);
    }

    private void initSpinners() {
        ArrayAdapter<LicenseCore.DurationItem> durationAdapter = new ArrayAdapter<>(
                this,
                android.R.layout.simple_spinner_item,
                LicenseCore.DURATION_ITEMS
        );
        durationAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        spinnerDuration.setAdapter(durationAdapter);

        ArrayAdapter<LicenseCore.RunsItem> runsAdapter = new ArrayAdapter<>(
                this,
                android.R.layout.simple_spinner_item,
                LicenseCore.RUNS_ITEMS
        );
        runsAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        spinnerRuns.setAdapter(runsAdapter);
    }

    private void initListeners() {
        etRequestCode.addTextChangedListener(new TextWatcher() {
            @Override
            public void beforeTextChanged(CharSequence s, int start, int count, int after) {}

            @Override
            public void onTextChanged(CharSequence s, int start, int before, int count) {}

            @Override
            public void afterTextChanged(Editable s) {
                validateRequestCode(s.toString());
            }
        });

        btnPaste.setOnClickListener(v -> pasteFromClipboard());

        btnGenerate.setOnClickListener(v -> generateLicense());

        btnCopyCode.setOnClickListener(v -> {
            if (!lastGeneratedLicense.isEmpty()) {
                copyTextToClipboard("商业授权激活码", lastGeneratedLicense);
                Toast.makeText(MainActivity.this, "📋 激活码已复制到剪贴板！", Toast.LENGTH_SHORT).show();
            }
        });

        btnCopyTemplate.setOnClickListener(v -> {
            if (!lastGeneratedLicense.isEmpty() && currentReqResult != null) {
                LicenseCore.DurationItem dItem = (LicenseCore.DurationItem) spinnerDuration.getSelectedItem();
                LicenseCore.RunsItem rItem = (LicenseCore.RunsItem) spinnerRuns.getSelectedItem();
                String template = "【国文创系统商业授权激活凭证】\n" +
                        "设备申请码: " + currentReqResult.formattedCode + "\n" +
                        "授权激活码: " + lastGeneratedLicense + "\n" +
                        "有效时长: " + dItem.label + "\n" +
                        "启动限制: " + rItem.label + "\n\n" +
                        "操作指引: 请在软件【商业授权激活中心】窗口中粘贴上述 12 位激活码并点击【立即激活】。\n" +
                        "官方授权与技术支持热线/微信: 19203642022\n" +
                        "注: 授权码具备单次核销安全机制，激活后即完成绑定，请妥善保存。";
                copyTextToClipboard("商业授权凭证", template);
                Toast.makeText(MainActivity.this, "💬 客户回复语已复制到剪贴板！", Toast.LENGTH_SHORT).show();
            } else {
                Toast.makeText(MainActivity.this, "请先生成激活码", Toast.LENGTH_SHORT).show();
            }
        });

        tvClearHistory.setOnClickListener(v -> {
            sp.edit().remove(KEY_HISTORY).apply();
            loadHistory();
            Toast.makeText(MainActivity.this, "签发历史已清空", Toast.LENGTH_SHORT).show();
        });

        if (btnCopyContact != null) {
            btnCopyContact.setOnClickListener(v -> {
                copyTextToClipboard("官方授权支持热线", "19203642022");
                Toast.makeText(MainActivity.this, "已复制官方授权支持热线/微信: 19203642022", Toast.LENGTH_SHORT).show();
            });
        }
    }

    private void validateRequestCode(String raw) {
        StringBuilder sb = new StringBuilder();
        for (char c : raw.toUpperCase().toCharArray()) {
            if (LicenseCore.CHARSET.indexOf(c) != -1) {
                sb.append(c);
            }
        }

        if (sb.length() == 8) {
            currentReqResult = LicenseCore.decodeRequestCode(sb.toString());
            layoutBadge.setVisibility(View.VISIBLE);

            if (currentReqResult.valid) {
                String prodName = "通用标准";
                if ("VisualCast_Native".equals(currentReqResult.matchedProductId)) {
                    prodName = "VisualCast 播控原生端 (Python/Android)";
                } else if ("ShengLi".equals(currentReqResult.matchedProductId)) {
                    prodName = "胜利油田科普馆控制系统 (HTML)";
                } else if ("Manual".equals(currentReqResult.matchedProductId)) {
                    prodName = "多媒体工程师全栈手册 (HTML)";
                } else if ("VisualCast".equals(currentReqResult.matchedProductId)) {
                    prodName = "VisualCast 通用加壳端";
                }

                tvBadgeStatus.setText("✅ 申请码合法 | 体系: " + prodName);
                tvBadgeStatus.setTextColor(Color.parseColor("#10B981"));
                tvBadgeInfo.setText(String.format("硬件指纹: #MC-%03X | 随机代际: #%04X", currentReqResult.hwHash, currentReqResult.nonce));
                tvBadgeInfo.setTextColor(Color.parseColor("#38BDF8"));
            } else {
                tvBadgeStatus.setText("❌ 校验失败");
                tvBadgeStatus.setTextColor(Color.parseColor("#EF4444"));
                tvBadgeInfo.setText(currentReqResult.error);
                tvBadgeInfo.setTextColor(Color.parseColor("#F87171"));
            }
        } else if (sb.length() > 0) {
            currentReqResult = null;
            layoutBadge.setVisibility(View.VISIBLE);
            tvBadgeStatus.setText("⏳ 正在输入... (当前 " + sb.length() + "/8 位)");
            tvBadgeStatus.setTextColor(Color.parseColor("#F59E0B"));
            tvBadgeInfo.setText("有效字符由 2-9 与 A-Z (排除 0,1,I,O) 组成");
            tvBadgeInfo.setTextColor(Color.parseColor("#94A3B8"));
        } else {
            currentReqResult = null;
            layoutBadge.setVisibility(View.GONE);
        }
    }

    private void generateLicense() {
        hideKeyboard();
        String code = etRequestCode.getText().toString().trim();
        validateRequestCode(code);

        if (currentReqResult == null || !currentReqResult.valid) {
            Toast.makeText(this, "⚠️ 请先输入有效的 8 位设备申请码！", Toast.LENGTH_SHORT).show();
            return;
        }

        LicenseCore.DurationItem dItem = (LicenseCore.DurationItem) spinnerDuration.getSelectedItem();
        LicenseCore.RunsItem rItem = (LicenseCore.RunsItem) spinnerRuns.getSelectedItem();

        String license = LicenseCore.encodeLicense(
                currentReqResult.hwHash,
                currentReqResult.nonce,
                dItem.code,
                rItem.code,
                currentReqResult.matchedProductId
        );

        if (license.isEmpty()) {
            Toast.makeText(this, "生成失败，请重试", Toast.LENGTH_SHORT).show();
            return;
        }

        lastGeneratedLicense = license;
        lastSelectedDurationLabel = dItem.label;

        layoutResult.setVisibility(View.VISIBLE);
        tvLicenseCode.setText(license);

        copyTextToClipboard("商业授权激活码", license);
        Toast.makeText(this, "🛡️ 激活码签发成功！已自动复制", Toast.LENGTH_SHORT).show();

        saveToHistory(currentReqResult.formattedCode, license, dItem.label, rItem.label);
    }

    private void pasteFromClipboard() {
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip().getItemCount() > 0) {
            CharSequence text = cm.getPrimaryClip().getItemAt(0).getText();
            if (text != null) {
                String raw = text.toString();
                StringBuilder validChars = new StringBuilder();
                for (char c : raw.toUpperCase().toCharArray()) {
                    if (LicenseCore.CHARSET.indexOf(c) != -1) {
                        validChars.append(c);
                        if (validChars.length() == 8) break;
                    }
                }
                if (validChars.length() == 8) {
                    String fmt = validChars.substring(0, 4) + "-" + validChars.substring(4);
                    etRequestCode.setText(fmt);
                    etRequestCode.setSelection(fmt.length());
                    Toast.makeText(this, "已智能提取并填入申请码: " + fmt, Toast.LENGTH_SHORT).show();
                } else {
                    etRequestCode.setText(raw.trim());
                    Toast.makeText(this, "已粘贴剪贴板内容", Toast.LENGTH_SHORT).show();
                }
            }
        } else {
            Toast.makeText(this, "剪贴板为空", Toast.LENGTH_SHORT).show();
        }
    }

    private void copyTextToClipboard(String label, String text) {
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm != null) {
            ClipData clip = ClipData.newPlainText(label, text);
            cm.setPrimaryClip(clip);
        }
    }

    private void saveToHistory(String reqCode, String licCode, String duration, String runs) {
        try {
            String historyJson = sp.getString(KEY_HISTORY, "[]");
            JSONArray arr = new JSONArray(historyJson);

            JSONObject item = new JSONObject();
            item.put("req", reqCode);
            item.put("lic", licCode);
            item.put("duration", duration);
            item.put("runs", runs);
            item.put("time", new SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(new Date()));

            JSONArray newArr = new JSONArray();
            newArr.put(item);
            for (int i = 0; i < Math.min(arr.length(), 20); i++) {
                newArr.put(arr.getJSONObject(i));
            }

            sp.edit().putString(KEY_HISTORY, newArr.toString()).apply();
            loadHistory();
        } catch (Exception e) {}
    }

    private void loadHistory() {
        layoutHistoryList.removeAllViews();
        try {
            String historyJson = sp.getString(KEY_HISTORY, "[]");
            JSONArray arr = new JSONArray(historyJson);

            if (arr.length() == 0) {
                TextView emptyTv = new TextView(this);
                emptyTv.setText("暂无签发记录");
                emptyTv.setTextColor(Color.parseColor("#64748B"));
                emptyTv.setTextSize(12);
                emptyTv.setPadding(0, 10, 0, 10);
                layoutHistoryList.addView(emptyTv);
                return;
            }

            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.getJSONObject(i);
                final String lic = obj.optString("lic");
                String req = obj.optString("req");
                String dur = obj.optString("duration");
                String runs = obj.optString("runs", "无限制");
                String time = obj.optString("time");

                LinearLayout row = new LinearLayout(this);
                row.setOrientation(LinearLayout.VERTICAL);
                row.setBackgroundColor(Color.parseColor("#1E293B"));
                row.setPadding(24, 16, 24, 16);
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT
                );
                lp.setMargins(0, 8, 0, 8);
                row.setLayoutParams(lp);

                LinearLayout topRow = new LinearLayout(this);
                topRow.setOrientation(LinearLayout.HORIZONTAL);

                TextView tvLic = new TextView(this);
                tvLic.setText(lic);
                tvLic.setTextColor(Color.parseColor("#38BDF8"));
                tvLic.setTextSize(15);
                tvLic.setTextScaleX(1.05f);
                topRow.addView(tvLic, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

                TextView tvTime = new TextView(this);
                tvTime.setText(time);
                tvTime.setTextColor(Color.parseColor("#64748B"));
                tvTime.setTextSize(11);
                topRow.addView(tvTime);

                row.addView(topRow);

                TextView tvSub = new TextView(this);
                tvSub.setText("申请码: " + req + " | " + dur + " | " + runs + " (点击复制)");
                tvSub.setTextColor(Color.parseColor("#94A3B8"));
                tvSub.setTextSize(12);
                tvSub.setPadding(0, 6, 0, 0);
                row.addView(tvSub);

                row.setOnClickListener(v -> {
                    copyTextToClipboard("商业授权激活码", lic);
                    Toast.makeText(MainActivity.this, "📋 激活码 " + lic + " 已复制", Toast.LENGTH_SHORT).show();
                });

                layoutHistoryList.addView(row);
            }
        } catch (Exception e) {}
    }

    private void hideKeyboard() {
        View v = getCurrentFocus();
        if (v != null) {
            InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null) imm.hideSoftInputFromWindow(v.getWindowToken(), 0);
        }
    }
}
