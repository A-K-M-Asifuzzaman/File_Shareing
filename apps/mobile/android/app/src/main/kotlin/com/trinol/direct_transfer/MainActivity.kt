package com.trinol.direct_transfer

import android.content.ContentValues
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileInputStream

/**
 * Publishing received files where the phone can actually find them.
 *
 * The transfer streams into the app's own storage, which is the only place it
 * can write a growing file it needs to seek, rename and delete. Nothing else
 * on the device can read that directory — from Android 11 the system hides
 * Android/data from file managers, and the gallery never indexed it — so a
 * finished transfer was invisible to the person who accepted it.
 *
 * Once a file is complete and its checksum matches, it moves into the shared
 * Downloads collection, which is what "it went to Downloads" means to everyone
 * who is not an Android developer.
 */
class MainActivity : FlutterActivity() {
    private val channel = "direct/downloads"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channel)
            .setMethodCallHandler { call, result ->
                if (call.method != "publish") {
                    result.notImplemented()
                    return@setMethodCallHandler
                }
                val source = call.argument<String>("path")
                val name = call.argument<String>("name")
                if (source == null || name == null) {
                    result.error("bad_args", "path and name are required", null)
                    return@setMethodCallHandler
                }
                try {
                    result.success(publish(File(source), name, call.argument<String>("subPath") ?: ""))
                } catch (e: Exception) {
                    result.error("publish_failed", e.message, null)
                }
            }
    }

    /** Returns where the file ended up, in words a person can act on. */
    private fun publish(source: File, name: String, subPath: String): String {
        if (!source.exists()) throw IllegalStateException("${source.name} is no longer there")

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            publishViaMediaStore(source, name, subPath)
        } else {
            publishViaFilesystem(source, name, subPath)
        }
    }

    /**
     * Scoped storage. The entry is created pending, so a half-copied file is
     * never offered to the gallery under a name that suggests it is ready —
     * the same reason the transfer writes to a .part file in the first place.
     *
     * ponytail: this copies rather than moves, because MediaStore will not
     * adopt a path the app already wrote. At photo and video sizes it is
     * imperceptible; a 100 GB transfer pays for a second pass over the disk.
     * Writing the chunks straight to the MediaStore descriptor would avoid it,
     * and costs a platform-channel round trip per 64 KB chunk instead.
     */
    private fun publishViaMediaStore(source: File, name: String, subPath: String): String {
        val relative = if (subPath.isEmpty()) {
            Environment.DIRECTORY_DOWNLOADS
        } else {
            "${Environment.DIRECTORY_DOWNLOADS}/$subPath"
        }

        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, name)
            put(MediaStore.Downloads.RELATIVE_PATH, relative)
            mimeOf(name)?.let { put(MediaStore.Downloads.MIME_TYPE, it) }
            put(MediaStore.Downloads.IS_PENDING, 1)
        }

        val resolver = contentResolver
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw IllegalStateException("Downloads would not accept $name")

        try {
            resolver.openOutputStream(uri).use { out ->
                if (out == null) throw IllegalStateException("could not open $name for writing")
                FileInputStream(source).use { it.copyTo(out, 1 shl 16) }
            }
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }

        resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        source.delete()
        return relative.replace(Environment.DIRECTORY_DOWNLOADS, "Downloads")
    }

    /** Before scoped storage, Downloads was just a directory. */
    private fun publishViaFilesystem(source: File, name: String, subPath: String): String {
        val downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        val dir = if (subPath.isEmpty()) downloads else File(downloads, subPath)
        dir.mkdirs()

        var target = File(dir, name)
        var n = 1
        val stem = name.substringBeforeLast('.', name)
        val ext = name.substringAfterLast('.', "")
        while (target.exists()) {
            target = File(dir, if (ext.isEmpty()) "$stem ($n)" else "$stem ($n).$ext")
            n++
        }

        if (!source.renameTo(target)) {
            source.copyTo(target, overwrite = false)
            source.delete()
        }
        return target.parent ?: "Downloads"
    }

    /** The gallery only shows a video if something told it that it is one. */
    private fun mimeOf(name: String): String? {
        val ext = name.substringAfterLast('.', "").lowercase()
        if (ext.isEmpty()) return null
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)
    }
}
