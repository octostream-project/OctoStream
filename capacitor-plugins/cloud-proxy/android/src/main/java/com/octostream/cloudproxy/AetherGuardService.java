package com.octostream.cloudproxy;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * Guardián de aether: foreground service vacío cuya única función es
 * mantener el proceso de la app en estado "foreground" mientras WARP está
 * activo. Sin él Android clasifica el proceso como cached/background y el
 * phantom process killer liquida al hijo libaether.so en cuanto quema CPU
 * escaneando gateways (observado en logcat: proceso muerto ~2s tras
 * arrancar, sin tombstone — kill externo, no crash).
 *
 * No toca la red ni el túnel: la lógica sigue en CloudProxyPlugin.
 * Notification obligatoria (API 26+) con IMPORTANCE_LOW para no molestar.
 */
public class AetherGuardService extends Service {
    private static final String TAG = "AetherGuard";
    public static final String ACTION_STOP = "com.octostream.aether.STOP";
    private static final int NOTIF_ID = 42131;
    private static final String CHANNEL_ID = "octo-warp";

    private static volatile boolean running = false;
    public static boolean isRunning() { return running; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            running = false;
            if (Build.VERSION.SDK_INT >= 33) stopForeground(STOP_FOREGROUND_REMOVE);
            else stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(
                    CHANNEL_ID, "OctoStream WARP", NotificationManager.IMPORTANCE_LOW));
        }
        Notification.Builder nb = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        Notification n = nb
                .setSmallIcon(android.R.drawable.ic_lock_lock)
                .setContentTitle("WARP activo")
                .setContentText("La conexión de OctoStream sale por Cloudflare")
                .setOngoing(true)
                .build();
        startForeground(NOTIF_ID, n);
        running = true;
        Log.i(TAG, "aether guard up — proceso de la app marcado foreground");
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // El usuario quitó la app de recents: cerrar de verdad — matar
        // aether y el guardián. Sin esto el FGS mantendría el proceso vivo
        // (y el túnel) aunque el usuario cerrase la app.
        CloudProxyPlugin.killAetherProcess();
        running = false;
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override
    public android.os.IBinder onBind(Intent intent) { return null; }
}
