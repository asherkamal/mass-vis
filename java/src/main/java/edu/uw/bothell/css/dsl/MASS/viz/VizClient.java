package edu.uw.bothell.css.dsl.MASS.viz;

import com.google.gson.JsonObject;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.util.concurrent.CompletableFuture;

/**
 * Transport for mass-viz protocol events: either a live WebSocket connection
 * to a mass-viz server (see ../../../../../../../../server), or an
 * append-only NDJSON recording file consumable later via the server's
 * /recordings endpoint or directly by the viewer's replay mode.
 *
 * Uses the JDK's built-in java.net.http.WebSocket client (Java 11+) rather
 * than pulling in a separate WebSocket dependency. Sends are serialized
 * through a completion chain since the JDK client permits only one
 * outstanding sendText() at a time.
 */
final class VizClient {

    private WebSocket socket;
    private BufferedWriter fileWriter;
    private CompletableFuture<WebSocket> sendChain = CompletableFuture.completedFuture(null);

    private VizClient() {
    }

    static VizClient connect(String wsUrl) {
        VizClient c = new VizClient();
        try {
            WebSocket.Listener listener = new WebSocket.Listener() {
                @Override
                public void onError(WebSocket webSocket, Throwable error) {
                    System.err.println("[mass-viz] WebSocket error: " + error);
                }
            };
            c.socket = HttpClient.newHttpClient()
                    .newWebSocketBuilder()
                    .buildAsync(URI.create(wsUrl), listener)
                    .join();
            c.sendChain = CompletableFuture.completedFuture(c.socket);
        } catch (Exception e) {
            throw new RuntimeException("mass-viz: failed to connect to " + wsUrl, e);
        }
        return c;
    }

    static VizClient record(File file) {
        VizClient c = new VizClient();
        try {
            c.fileWriter = new BufferedWriter(new FileWriter(file, false));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return c;
    }

    synchronized void send(JsonObject event) {
        String line = event.toString();
        if (fileWriter != null) {
            try {
                fileWriter.write(line);
                fileWriter.newLine();
                fileWriter.flush();
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
            return;
        }
        if (socket != null) {
            sendChain = sendChain.thenCompose(ws -> socket.sendText(line, true));
        }
    }

    synchronized void close() {
        if (socket != null) {
            sendChain.thenRun(() -> socket.sendClose(WebSocket.NORMAL_CLOSURE, "done"));
        }
        if (fileWriter != null) {
            try {
                fileWriter.close();
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        }
    }
}
