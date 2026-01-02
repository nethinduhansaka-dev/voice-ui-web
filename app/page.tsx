import AudioRecorder from "./components/AudioRecorder";

export default function Home() {
  return (
    <div className="min-h-screen bg-black px-4 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
          Microphone Access
        </h1>
        <AudioRecorder />
      </div>
    </div>
  );
}
