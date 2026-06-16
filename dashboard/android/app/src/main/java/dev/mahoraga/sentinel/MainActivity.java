package dev.mahoraga.sentinel;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SentinelUpdatePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
