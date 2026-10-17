// Lint fixture. Each line marked "bad" must be reported, each "good" line must not.
const size = 'p-16';

export function Card() {
  return (
    <div className="p-[13px] bg-ground">
      <span className="text-[#ff0000]">bad</span>
      <span className={`${size} rounded-[3px]`}>bad</span>
      <span className="[mask-type:luminance]">bad</span>
      <span className="bg-ink/[0.3]">bad</span>
      <span className="p-(--my-space)">bad</span>
      <span className="min-[700px]:p-16">bad</span>
      <span className="transition duration-200">bad</span>
      <span className="bg-raised text-ink/60">bad</span>
      <span className="p-16 text-ink rounded-md duration-base sm:p-8">good</span>
      <span className="data-[state=open]:bg-raised aria-[expanded=true]:text-ink">good</span>
    </div>
  );
}
