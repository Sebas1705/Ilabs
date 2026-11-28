package es.sebas1705.ilabs.demo

import android.content.res.AssetManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Reads every fixture of one module from the assets, where the copyContracts task puts the contracts folder. */
private fun AssetManager.loaderFor(module: String) = FixtureLoader {
    val dir = "contracts/$module"
    list(dir).orEmpty()
        .filter { it.endsWith(".json") }
        .map { name -> open("$dir/$name").bufferedReader().use { it.readText() } }
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val providersLoader = assets.loaderFor("providers")
        val structuredLoader = assets.loaderFor("structured")
        val contextLoader = assets.loaderFor("context")
        val evalsLoader = assets.loaderFor("evals")
        val ragLoader = assets.loaderFor("rag")
        val guardrailsLoader = assets.loaderFor("guardrails")
        val visionAssets = AssetVisionAssets(applicationContext)
        val visionPlatform = AndroidVisionPlatform(applicationContext)
        val visionImages = VisionImages(
            bitmap = { ref -> withContext(Dispatchers.IO) { visionPlatform.displayBitmap(ref) } },
            import = { uri -> withContext(Dispatchers.IO) { visionPlatform.importPicked(uri) } },
        )
        setContent {
            ILabsTheme {
                // Saved state, so the open module survives rotation, process death and "Don't keep activities".
                var module by rememberSaveable { mutableStateOf<DemoModule?>(null) }
                BackHandler(enabled = module != null) { module = null }
                when (module) {
                    null -> ModuleHome(onOpen = { module = it })
                    DemoModule.PROVIDERS -> {
                        val vm: ProvidersViewModel = viewModel(factory = ProvidersViewModel.factory(providersLoader))
                        val state by vm.uiState.collectAsStateWithLifecycle()
                        ProvidersScreen(state, vm::select, onBack = { module = null })
                    }
                    DemoModule.STRUCTURED -> {
                        val vm: StructuredViewModel = viewModel(factory = StructuredViewModel.factory(structuredLoader))
                        val state by vm.uiState.collectAsStateWithLifecycle()
                        StructuredScreen(state, vm::select, onBack = { module = null })
                    }
                    DemoModule.CONTEXT -> {
                        val vm: ContextViewModel = viewModel(factory = ContextViewModel.factory(contextLoader))
                        val state by vm.uiState.collectAsStateWithLifecycle()
                        ContextScreen(state, vm::select, vm::setBudget, onBack = { module = null })
                    }
                    DemoModule.EVALS -> {
                        val vm: EvalsViewModel = viewModel(factory = EvalsViewModel.factory(evalsLoader))
                        val state by vm.uiState.collectAsStateWithLifecycle()
                        EvalsScreen(state, EvalsActions.of(vm), onBack = { module = null })
                    }
                    DemoModule.RAG -> {
                        val vm: RagViewModel = viewModel(factory = RagViewModel.factory(ragLoader))
                        val state by vm.uiState.collectAsStateWithLifecycle()
                        RagScreen(state, RagActions.of(vm), onBack = { module = null })
                    }
                    DemoModule.GUARDRAILS -> {
                        val vm: GuardrailsViewModel = viewModel(factory = GuardrailsViewModel.factory(guardrailsLoader))
                        val state by vm.uiState.collectAsStateWithLifecycle()
                        GuardrailsScreen(state, GuardrailsActions.of(vm), onBack = { module = null })
                    }
                    DemoModule.VISION -> {
                        val vm: VisionViewModel = viewModel(factory = VisionViewModel.factory(visionAssets, visionPlatform))
                        val state by vm.uiState.collectAsStateWithLifecycle()
                        VisionScreen(state, VisionActions.of(vm, visionImages), onBack = { module = null })
                    }
                    DemoModule.ASSISTANT -> {
                        // Plain strings read from the current configuration: the view model outlives the Activity and must not keep it.
                        val replies = listOf(
                            stringResource(R.string.assistant_mock_reply_1), stringResource(R.string.assistant_mock_reply_2),
                            stringResource(R.string.assistant_mock_reply_3), stringResource(R.string.assistant_mock_reply_4),
                        )
                        val vm: AssistantViewModel = viewModel(factory = AssistantViewModel.factory(replies))
                        LaunchedEffect(replies) { vm.setReplies(replies) }
                        val state by vm.uiState.collectAsStateWithLifecycle()
                        AssistantScreen(state, AssistantActions.of(vm), onBack = { module = null })
                    }
                }
            }
        }
    }
}
