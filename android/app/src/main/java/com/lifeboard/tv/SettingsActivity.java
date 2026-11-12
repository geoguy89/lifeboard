package com.lifeboard.tv;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * The only screen with any chrome on it.
 *
 * Built in code rather than XML because the whole app is four screens and a
 * layout file per screen is more to keep in step than it saves. Everything is
 * sized generously and focusable: this gets driven with a fingertip on a wall,
 * or a D-pad from the sofa, and never with a mouse.
 */
public class SettingsActivity extends Activity {

    private EditText url;
    private RadioGroup orientation;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(build());
    }

    private View build() {
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setBackgroundColor(Color.parseColor("#0b0d11"));
        page.setPadding(64, 64, 64, 64);

        page.addView(heading("LifeBoard"));
        page.addView(hint("This screen shows a board that is running somewhere "
                + "else — your Pi, or any machine on the network."));

        page.addView(label("Board address"));
        url = new EditText(this);
        url.setText(Kiosk.boardUrl(this));
        url.setHint("http://lifeboard.local:8080/render/");
        url.setSingleLine(true);
        url.setTextColor(Color.WHITE);
        url.setHintTextColor(Color.parseColor("#5d6572"));
        url.setBackgroundColor(Color.parseColor("#171b22"));
        url.setPadding(28, 28, 28, 28);
        url.setTextSize(18);
        // URI, not TEXT: it puts "/" and ":" on the first keyboard page and
        // turns off the autocapitalise that otherwise sends "Http://".
        url.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        page.addView(url);
        page.addView(hint("The /render/ page, not /admin/. Leave the port on — "
                + "it is 8080 unless you changed it."));

        page.addView(label("Screen orientation"));
        orientation = new RadioGroup(this);
        orientation.setOrientation(RadioGroup.HORIZONTAL);
        String current = Kiosk.orientation(this);
        orientation.addView(radio("Landscape", "landscape", current));
        orientation.addView(radio("Portrait", "portrait", current));
        orientation.addView(radio("Follow the device", "auto", current));
        page.addView(orientation);

        page.addView(label("Touch screen"));
        boolean calibrated = Calibration.isCalibrated(this);
        page.addView(hint(calibrated
                ? "Calibrated. Redo this if the touches drift, or if the frame "
                  + "or TV is moved."
                : "Not calibrated — touches go straight through as the frame "
                  + "reports them. If they land off-target, calibrate."));

        page.addView(button("Calibrate touch screen", v ->
                startActivity(new Intent(this, CalibrationActivity.class))));

        if (calibrated) {
            page.addView(button("Clear calibration", v -> {
                Calibration.clear(this);
                Toast.makeText(this, "Back to raw touch", Toast.LENGTH_SHORT).show();
                recreate();
            }));
        }

        page.addView(spacer(32));
        page.addView(button("Save and show the board", v -> save()));

        page.addView(hint("\nTo get back here from the board: hold the top-left "
                + "corner for two seconds, or press MENU on the remote."));

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.parseColor("#0b0d11"));
        scroll.addView(page);
        return scroll;
    }

    private void save() {
        String value = url.getText().toString().trim();
        if (value.isEmpty()) {
            Toast.makeText(this, "Enter the board's address first",
                    Toast.LENGTH_LONG).show();
            return;
        }
        // Typing "192.0.2.50:8080" is what everybody actually does, and
        // WebView will not load it without a scheme - it searches for it.
        if (!value.startsWith("http://") && !value.startsWith("https://")) {
            value = "http://" + value;
        }
        Kiosk.setBoardUrl(this, value);

        int checked = orientation.getCheckedRadioButtonId();
        View picked = orientation.findViewById(checked);
        if (picked != null && picked.getTag() != null) {
            Kiosk.setOrientation(this, picked.getTag().toString());
        }
        finish();
    }

    /* ------------------------------------------------------------- pieces */

    private TextView heading(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextColor(Color.WHITE);
        view.setTextSize(30);
        view.setPadding(0, 0, 0, 8);
        return view;
    }

    private TextView label(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextColor(Color.parseColor("#8b93a1"));
        view.setTextSize(14);
        view.setAllCaps(true);
        view.setLetterSpacing(0.12f);
        view.setPadding(0, 44, 0, 12);
        return view;
    }

    private TextView hint(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextColor(Color.parseColor("#6d7583"));
        view.setTextSize(15);
        view.setPadding(0, 10, 0, 0);
        return view;
    }

    private RadioButton radio(String text, String tag, String current) {
        RadioButton button = new RadioButton(this);
        button.setText(text);
        button.setTag(tag);
        button.setTextColor(Color.WHITE);
        button.setTextSize(17);
        button.setPadding(12, 20, 48, 20);
        button.setChecked(tag.equals(current));
        return button;
    }

    private Button button(String text, View.OnClickListener onClick) {
        Button button = new Button(this);
        button.setText(text);
        button.setAllCaps(false);
        button.setTextSize(18);
        button.setPadding(32, 32, 32, 32);
        button.setOnClickListener(onClick);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = 20;
        button.setLayoutParams(params);
        button.setGravity(Gravity.CENTER);
        return button;
    }

    private View spacer(int height) {
        View view = new View(this);
        view.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, height));
        return view;
    }
}
