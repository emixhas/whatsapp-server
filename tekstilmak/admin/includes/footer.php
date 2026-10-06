    </main>
</div>
<script>
(function(){
  var t=document.getElementById('side-toggle');
  if(t){t.addEventListener('click',function(){document.body.classList.toggle('side-open');});}
  document.querySelectorAll('[data-confirm]').forEach(function(f){
    f.addEventListener('submit',function(e){ if(!confirm(f.getAttribute('data-confirm'))) e.preventDefault(); });
  });
  var slugSrc=document.querySelector('[data-slug-source]'), slugDst=document.querySelector('[data-slug-target]');
  if(slugSrc&&slugDst){
    var map={'ş':'s','Ş':'s','ı':'i','İ':'i','ğ':'g','Ğ':'g','ü':'u','Ü':'u','ö':'o','Ö':'o','ç':'c','Ç':'c'};
    var slugify=function(s){return s.replace(/[şŞıİğĞüÜöÖçÇ]/g,function(c){return map[c];}).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');};
    var model=document.querySelector('[data-slug-model]');
    var update=function(){ if(slugDst.dataset.touched==='1') return; slugDst.value=slugify((model?model.value+' ':'')+slugSrc.value); };
    slugSrc.addEventListener('input',update); if(model) model.addEventListener('input',update);
    slugDst.addEventListener('input',function(){ slugDst.dataset.touched='1'; });
  }
  document.querySelectorAll('input[type=file][data-preview]').forEach(function(inp){
    inp.addEventListener('change',function(){
      var img=document.querySelector(inp.getAttribute('data-preview')); if(!img||!inp.files[0]) return;
      img.src=URL.createObjectURL(inp.files[0]); img.style.display='block';
    });
  });
})();
</script>
</body>
</html>
