import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.FileSystemOperations
import org.gradle.api.file.FileTree
import org.gradle.api.tasks.CacheableTask
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import javax.inject.Inject

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

/** Copies every module's shared contract JSON into the app assets as `contracts/<module>/`; `contracts/` stays the single source. */
@CacheableTask
abstract class CopyContractsTask : DefaultTask() {
    /** Root of the shared contracts; only the JSON files one level down are inputs (READMEs are ignored). */
    @get:Internal
    abstract val contractsDir: DirectoryProperty

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    val contractFiles: FileTree
        get() = contractsDir.asFileTree.matching { include("*/*.json") }

    @get:OutputDirectory
    abstract val output: DirectoryProperty

    @get:Inject
    abstract val fs: FileSystemOperations

    @TaskAction
    fun copy() {
        fs.sync {
            from(contractsDir) { include("*/*.json") }
            into(output.dir("contracts"))
        }
    }
}

val copyContracts = tasks.register<CopyContractsTask>("copyContracts") {
    contractsDir.set(rootProject.layout.projectDirectory.dir("contracts"))
}

/**
 * Copies the shared vision demo assets (`demos/vision-assets`) into the app assets as `vision/`: the samples, the
 * recorded outputs, the labels and the two JSON indexes always, and the `.tflite` model files when they have been
 * downloaded (`node scripts/vision-models.mjs`). The models are git-ignored and optional: the build passes without them.
 */
abstract class CopyVisionAssetsTask : DefaultTask() {
    /** Root of the shared vision assets. */
    @get:Internal
    abstract val assetsDir: DirectoryProperty

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    val sharedFiles: FileTree
        get() = assetsDir.asFileTree.matching {
            include("samples/*.png", "recorded/*.json", "labels/*.txt", "samples.json", "models.json")
        }

    /** The downloaded models, if any (an absent folder is an empty tree). */
    @get:InputFiles
    @get:Optional
    @get:PathSensitive(PathSensitivity.RELATIVE)
    val modelFiles: FileTree
        get() = assetsDir.asFileTree.matching { include("models/*.tflite") }

    @get:OutputDirectory
    abstract val output: DirectoryProperty

    @get:Inject
    abstract val fs: FileSystemOperations

    @TaskAction
    fun copy() {
        fs.sync {
            from(assetsDir) {
                include("samples/*.png", "recorded/*.json", "labels/*.txt", "samples.json", "models.json", "models/*.tflite")
            }
            into(output.dir("vision"))
        }
    }
}

val copyVisionAssets = tasks.register<CopyVisionAssetsTask>("copyVisionAssets") {
    assetsDir.set(rootProject.layout.projectDirectory.dir("demos/vision-assets"))
}

android {
    namespace = "es.sebas1705.ilabs.demo"
    compileSdk = 37

    defaultConfig {
        applicationId = "es.sebas1705.ilabs.demo"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"
    }

    buildFeatures { compose = true }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyContracts, CopyContractsTask::output)
        variant.sources.assets?.addGeneratedSourceDirectory(copyVisionAssets, CopyVisionAssetsTask::output)
    }
}

dependencies {
    implementation(project(":modules:providers-kotlin"))
    implementation(project(":modules:structured-kotlin"))
    implementation(project(":modules:context-kotlin"))
    implementation(project(":modules:evals-kotlin"))
    implementation(project(":modules:rag-kotlin"))
    implementation(project(":modules:guardrails-kotlin"))
    implementation(project(":modules:vision-kotlin"))
    implementation(libs.litert)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit4)
    testImplementation(libs.kotlinx.coroutines.test)
}
